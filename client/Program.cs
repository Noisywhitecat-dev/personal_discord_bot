using System.Text;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

Console.OutputEncoding = Encoding.UTF8;
Console.Error.WriteLine("클라이언트 시작");

var targetFormat = new WaveFormat(48000, 16, 2);
using var stdout = Console.OpenStandardOutput();

if (args.Contains("--system"))
{
    await CaptureSystemAudioAsync(targetFormat, stdout);
}
else
{
    await CaptureProcessAudioAsync(targetFormat, stdout);
}

static async Task CaptureProcessAudioAsync(WaveFormat targetFormat, Stream stdout)
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
    await PumpToStdoutAsync(pcm16Provider, stdout);
}

static async Task CaptureSystemAudioAsync(WaveFormat targetFormat, Stream stdout)
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
    await PumpToStdoutAsync(pcm16Provider, stdout);
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

static async Task PumpToStdoutAsync(IWaveProvider provider, Stream stdout)
{
    var readBuffer = new byte[provider.WaveFormat.AverageBytesPerSecond / 10];
    while (true)
    {
        int bytesRead = provider.Read(readBuffer.AsSpan());
        if (bytesRead > 0)
        {
            await stdout.WriteAsync(readBuffer.AsMemory(0, bytesRead));
            await stdout.FlushAsync();
        }
        else
        {
            await Task.Delay(10);
        }
    }
}
