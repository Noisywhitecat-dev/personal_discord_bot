using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace AudioRelayClientGui;

public class MainForm : Form
{
    private static readonly Color AccentColor = Color.FromArgb(88, 101, 242);

    private readonly ListBox _processList = new()
    {
        Dock = DockStyle.Fill,
        Font = new Font("Segoe UI", 10f),
        BorderStyle = BorderStyle.None,
        IntegralHeight = false,
    };

    private readonly TextBox _serverBox = new()
    {
        Dock = DockStyle.Top,
        PlaceholderText = "서버 주소 (예: ws://host:port)",
        Margin = new Padding(0, 0, 0, 8),
    };

    private readonly TextBox _secretBox = new()
    {
        Dock = DockStyle.Top,
        PlaceholderText = "비밀키",
        UseSystemPasswordChar = true,
        Margin = new Padding(0, 0, 0, 8),
    };

    private readonly Button _refreshButton = new()
    {
        Text = "새로고침",
        Dock = DockStyle.Top,
        Height = 32,
        FlatStyle = FlatStyle.Flat,
    };

    private readonly Button _startStopButton = new()
    {
        Text = "시작",
        Dock = DockStyle.Top,
        Height = 44,
        Font = new Font("Segoe UI", 11f, FontStyle.Bold),
        FlatStyle = FlatStyle.Flat,
        BackColor = AccentColor,
        ForeColor = Color.White,
    };

    private readonly Label _statusLabel = new()
    {
        Dock = DockStyle.Bottom,
        Text = "대기 중",
        Height = 32,
        TextAlign = ContentAlignment.MiddleCenter,
        BackColor = Color.FromArgb(240, 240, 240),
    };

    private CancellationTokenSource? _cts;
    private Task? _relayTask;

    public MainForm()
    {
        Text = "Audio Relay Client";
        Width = 400;
        Height = 460;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Padding = new Padding(12);
        Font = new Font("Segoe UI", 9.5f);

        _refreshButton.FlatAppearance.BorderColor = Color.LightGray;
        _startStopButton.FlatAppearance.BorderSize = 0;

        _refreshButton.Click += (_, _) => RefreshProcessList();
        _startStopButton.Click += (_, _) => ToggleRelay();

        // Dock.Top 컨트롤은 먼저 추가된 것이 위쪽에 오므로, 표시 순서(서버 주소 → 비밀키 → 새로고침)대로 역순 추가.
        // 개별 컨트롤을 바로 Form에 붙여서, 숨겨질 때(Visible=false) 레이아웃 공간을 실제로 반환하게 한다.
        Controls.Add(_processList);
        Controls.Add(_startStopButton);
        Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 }); // 여백
        Controls.Add(_refreshButton);
        Controls.Add(_secretBox);
        Controls.Add(_serverBox);
        Controls.Add(_statusLabel);

        ApplyEmbeddedConnectionSettings();
        RefreshProcessList();
    }

    /// <summary>
    /// 빌드 시 client-gui/secrets.local.json(gitignore 대상)이 있으면 그 값을 실행파일에 내장한다.
    /// 내장된 값이 있으면 서버 주소/비밀키 입력창을 숨겨 사용자는 캡처 대상 선택 후 시작만 누르면 된다.
    /// 내장된 값이 없으면(공개 저장소를 그대로 빌드한 경우) 직접 입력할 수 있도록 입력창을 보여준다.
    /// </summary>
    private void ApplyEmbeddedConnectionSettings()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith("secrets.local.json", StringComparison.OrdinalIgnoreCase));

        if (resourceName == null)
        {
            return;
        }

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            return;
        }

        var settings = JsonSerializer.Deserialize<ConnectionSettings>(
            stream, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (settings?.ServerUrl == null || settings.Secret == null)
        {
            return;
        }

        _serverBox.Text = settings.ServerUrl;
        _secretBox.Text = settings.Secret;
        _serverBox.Visible = false;
        _secretBox.Visible = false;
    }

    private sealed class ConnectionSettings
    {
        public string? ServerUrl { get; set; }
        public string? Secret { get; set; }
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
            var agc = new SimpleAgc();

            while (await timer.WaitForNextTickAsync(token))
            {
                int bytesRead = pcm16Provider.Read(readBuffer.AsSpan());
                if (bytesRead > 0)
                {
                    agc.Process(readBuffer, bytesRead);
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
