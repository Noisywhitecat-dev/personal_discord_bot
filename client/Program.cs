using System.Text;
using AudioRelayClient;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

Console.OutputEncoding = Encoding.UTF8;
Console.Error.WriteLine("클라이언트 시작");

var targetFormat = new WaveFormat(48000, 16, 2);
var serverUrl = GetArgValue(args, "--server");

Func<byte[], int, Task> sink;
WsAudioSink? wsSink = null;
Stream? stdout = null;

if (serverUrl != null)
{
    var secret = GetArgValue(args, "--secret");
    wsSink = await WsAudioSink.ConnectAsync(serverUrl, secret);
    sink = wsSink.SendAsync;
}
else
{
    stdout = Console.OpenStandardOutput();
    var stdoutStream = stdout;
    sink = async (buffer, count) =>
    {
        await stdoutStream.WriteAsync(buffer.AsMemory(0, count));
        await stdoutStream.FlushAsync();
    };
}

try
{
    if (args.Contains("--system"))
    {
        await CaptureSystemAudioAsync(targetFormat, sink);
    }
    else
    {
        await CaptureProcessAudioAsync(targetFormat, sink);
    }
}
finally
{
    if (wsSink != null)
    {
        await wsSink.DisposeAsync();
    }
    stdout?.Dispose();
}

static string? GetArgValue(string[] args, string name)
{
    int index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

static async Task CaptureProcessAudioAsync(WaveFormat targetFormat, Func<byte[], int, Task> sink)
{
    using var enumerator = new MMDeviceEnumerator();
    using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    var sessions = device.AudioSessionManager.Sessions;

    var candidates = new List<(uint Pid, string Name)>();
    var seenPids = new HashSet<uint>();

    for (int i = 0; i < sessions.Count; i++)
    {
        uint pid = sessions[i].GetProcessID;
        if (pid == 0 || !seenPids.Add(pid))
        {
            continue;
        }

        try
        {
            var process = System.Diagnostics.Process.GetProcessById((int)pid);
            candidates.Add((pid, process.ProcessName));
        }
        catch (ArgumentException)
        {
            // 이미 종료된 프로세스
        }
    }

    if (candidates.Count == 0)
    {
        Console.Error.WriteLine("현재 오디오 세션을 가진 프로세스가 없습니다. 소리를 재생 중인 앱이 있는지 확인해주세요.");
        return;
    }

    Console.Error.WriteLine("캡처할 프로세스를 선택하세요:");
    for (int i = 0; i < candidates.Count; i++)
    {
        Console.Error.WriteLine($"  [{i}] {candidates[i].Name} (PID {candidates[i].Pid})");
    }
    Console.Error.Write("번호 입력: ");

    var input = Console.ReadLine();
    if (!int.TryParse(input, out int choice) || choice < 0 || choice >= candidates.Count)
    {
        Console.Error.WriteLine("잘못된 선택입니다.");
        return;
    }

    var (targetPid, targetName) = candidates[choice];
    Console.Error.WriteLine($"'{targetName}' (PID {targetPid}) 캡처 준비 중...");

    await using var recorder = await new WasapiRecorderBuilder()
        .WithProcessLoopback(targetPid, ProcessLoopbackMode.IncludeTargetProcessTree)
        .BuildAsync();

    var buffered = new BufferedWaveProvider(recorder.WaveFormat, TimeSpan.FromSeconds(5))
    {
        DiscardOnBufferOverflow = true,
    };

    recorder.DataAvailable += (buffer, _, _, _) =>
    {
        var bytes = buffer.ToArray();
        buffered.AddSamples(bytes, 0, bytes.Length);
    };

    recorder.RecordingStopped += (_, _) =>
    {
        Console.Error.WriteLine("캡처 종료");
    };

    recorder.StartRecording();
    Console.Error.WriteLine($"'{targetName}' 실시간 캡처 시작 (Ctrl+C로 종료)");

    var pcm16Provider = BuildConverter(buffered, targetFormat);
    await PumpAsync(pcm16Provider, sink);
}

static async Task CaptureSystemAudioAsync(WaveFormat targetFormat, Func<byte[], int, Task> sink)
{
    using var capture = new WasapiLoopbackCapture();

    var buffered = new BufferedWaveProvider(capture.WaveFormat, TimeSpan.FromSeconds(5))
    {
        DiscardOnBufferOverflow = true,
    };

    capture.DataAvailable += (_, e) => buffered.AddSamples(e.Buffer, 0, e.BytesRecorded);
    capture.RecordingStopped += (_, e) =>
    {
        if (e.Exception != null)
        {
            Console.Error.WriteLine($"캡처 오류: {e.Exception.Message}");
        }
        Console.Error.WriteLine("캡처 종료");
    };

    capture.StartRecording();
    Console.Error.WriteLine("시스템 오디오 캡처 시작 (Ctrl+C로 종료)");

    var pcm16Provider = BuildConverter(buffered, targetFormat);
    await PumpAsync(pcm16Provider, sink);
}

static IWaveProvider BuildConverter(BufferedWaveProvider buffered, WaveFormat targetFormat)
{
    ISampleProvider sampleProvider = buffered.ToSampleProvider();

    if (buffered.WaveFormat.Channels == 1 && targetFormat.Channels == 2)
    {
        sampleProvider = new MonoToStereoSampleProvider(sampleProvider);
    }

    if (sampleProvider.WaveFormat.SampleRate != targetFormat.SampleRate)
    {
        sampleProvider = new WdlResamplingSampleProvider(sampleProvider, targetFormat.SampleRate);
    }

    return sampleProvider.ToWaveProvider16();
}

static async Task PumpAsync(IWaveProvider provider, Func<byte[], int, Task> sink)
{
    // BufferedWaveProvider(ReadFully: true)는 데이터가 없으면 무음으로 채워서 즉시 반환하므로,
    // 전송 계층의 자연스러운 백프레셔(예: 표준출력 파이프)가 없으면 이 루프가 CPU 한계까지
    // 폭주하며 무음을 실제 오디오처럼 계속 내보낼 수 있다. PeriodicTimer로 실제 청크 길이(100ms)에
    // 맞춰 직접 페이싱해서, 전송 방식과 무관하게 항상 실시간 속도로만 Read/전송하도록 한다.
    var chunkDuration = TimeSpan.FromMilliseconds(100);
    var readBuffer = new byte[provider.WaveFormat.AverageBytesPerSecond / 10];
    using var timer = new PeriodicTimer(chunkDuration);
    var agc = new AudioRelayClient.SimpleAgc();

    while (await timer.WaitForNextTickAsync())
    {
        int bytesRead = provider.Read(readBuffer.AsSpan());
        if (bytesRead > 0)
        {
            agc.Process(readBuffer, bytesRead);
            await sink(readBuffer, bytesRead);
        }
    }
}
