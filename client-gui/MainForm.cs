using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace AudioRelayClientGui;

public class MainForm : Form
{
    private readonly ListBox _processList = new() { Dock = DockStyle.Fill };
    private readonly TextBox _serverBox = new() { Dock = DockStyle.Top, Text = "ws://168.110.49.81:8081" };
    private readonly TextBox _secretBox = new() { Dock = DockStyle.Top, PlaceholderText = "비밀키", UseSystemPasswordChar = true };
    private readonly Button _refreshButton = new() { Text = "새로고침", Dock = DockStyle.Top };
    private readonly Button _startStopButton = new() { Text = "시작", Dock = DockStyle.Top, Height = 40 };
    private readonly Label _statusLabel = new() { Dock = DockStyle.Bottom, Text = "대기 중", Height = 24 };

    private CancellationTokenSource? _cts;
    private Task? _relayTask;

    public MainForm()
    {
        Text = "Audio Relay Client";
        Width = 420;
        Height = 480;

        _refreshButton.Click += (_, _) => RefreshProcessList();
        _startStopButton.Click += (_, _) => ToggleRelay();

        // Dock.Top 컨트롤은 먼저 추가된 것이 위쪽에 오므로, 표시 순서(서버 주소 → 비밀키 → 새로고침)대로 역순 추가
        var topPanel = new Panel { Dock = DockStyle.Top, Height = 100 };
        topPanel.Controls.Add(_refreshButton);
        topPanel.Controls.Add(_secretBox);
        topPanel.Controls.Add(_serverBox);

        Controls.Add(_processList);
        Controls.Add(_startStopButton);
        Controls.Add(topPanel);
        Controls.Add(_statusLabel);

        RefreshProcessList();
    }

    private void RefreshProcessList()
    {
        _processList.Items.Clear();

        using var enumerator = new MMDeviceEnumerator();
        using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        var sessions = device.AudioSessionManager.Sessions;

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
                _processList.Items.Add(new ProcessEntry(pid, process.ProcessName));
            }
            catch (ArgumentException)
            {
                // 이미 종료된 프로세스
            }
        }
    }

    private void ToggleRelay()
    {
        if (_relayTask == null)
        {
            if (_processList.SelectedItem is not ProcessEntry entry)
            {
                MessageBox.Show("캡처할 프로세스를 선택해주세요.");
                return;
            }

            _cts = new CancellationTokenSource();
            _relayTask = RunRelayAsync(entry, _serverBox.Text, _secretBox.Text, _cts.Token);

            _startStopButton.Text = "중지";
            _processList.Enabled = false;
            _serverBox.Enabled = false;
            _secretBox.Enabled = false;
            _refreshButton.Enabled = false;
        }
        else
        {
            _cts?.Cancel();
            _relayTask = null;

            _startStopButton.Text = "시작";
            _processList.Enabled = true;
            _serverBox.Enabled = true;
            _secretBox.Enabled = true;
            _refreshButton.Enabled = true;
            SetStatus("중지됨");
        }
    }

    private async Task RunRelayAsync(ProcessEntry entry, string serverUrl, string secret, CancellationToken token)
    {
        try
        {
            SetStatus($"'{entry.Name}' 연결 중...");

            using var socket = new ClientWebSocket();
            await socket.ConnectAsync(new Uri(serverUrl), token);

            var authJson = JsonSerializer.Serialize(new { secret });
            await socket.SendAsync(Encoding.UTF8.GetBytes(authJson), WebSocketMessageType.Text, endOfMessage: true, token);

            var targetFormat = new WaveFormat(48000, 16, 2);

            await using var recorder = await new WasapiRecorderBuilder()
                .WithProcessLoopback(entry.Pid, ProcessLoopbackMode.IncludeTargetProcessTree)
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

            recorder.StartRecording();
            SetStatus($"'{entry.Name}' 캡처 중");

            var pcm16Provider = BuildConverter(buffered, targetFormat);
            var readBuffer = new byte[pcm16Provider.WaveFormat.AverageBytesPerSecond / 10];
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));

            while (await timer.WaitForNextTickAsync(token))
            {
                int bytesRead = pcm16Provider.Read(readBuffer.AsSpan());
                if (bytesRead > 0)
                {
                    await socket.SendAsync(
                        new ArraySegment<byte>(readBuffer, 0, bytesRead),
                        WebSocketMessageType.Binary,
                        endOfMessage: true,
                        token);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 사용자가 중지함
        }
        catch (Exception ex)
        {
            SetStatus($"오류: {ex.Message}");
        }
    }

    private static IWaveProvider BuildConverter(BufferedWaveProvider buffered, WaveFormat targetFormat)
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

    private void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => _statusLabel.Text = text);
        }
        else
        {
            _statusLabel.Text = text;
        }
    }

    private sealed record ProcessEntry(uint Pid, string Name)
    {
        public override string ToString() => $"{Name} (PID {Pid})";
    }
}
