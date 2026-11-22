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

    private readonly TextBox _codeBox = new()
    {
        Dock = DockStyle.Top,
        PlaceholderText = "접속 코드 (디스코드 /start에서 받은 6자리)",
        MaxLength = 6,
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

        // Dock.Top 컨트롤은 먼저 추가된 것이 위쪽에 오므로, 표시 순서(서버 주소 → 접속 코드 → 새로고침)대로 역순 추가.
        // 개별 컨트롤을 바로 Form에 붙여서, 숨겨질 때(Visible=false) 레이아웃 공간을 실제로 반환하게 한다.
        Controls.Add(_processList);
        Controls.Add(_startStopButton);
        Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 }); // 여백
        Controls.Add(_refreshButton);
        Controls.Add(_codeBox);
        Controls.Add(_serverBox);
        Controls.Add(_statusLabel);

        ApplyEmbeddedConnectionSettings();
        RefreshProcessList();
    }

    /// <summary>
    /// 빌드 시 client-gui/secrets.local.json(gitignore 대상)이 있으면 서버 주소를 실행파일에 내장한다.
    /// 내장된 값이 있으면 서버 주소 입력창을 숨긴다. 비밀키는 내장하지 않고, 사용자는 디스코드 /start로 받은
    /// 일회용 접속 코드를 입력한다. 내장된 값이 없으면(공개 저장소를 그대로 빌드한 경우) 서버 주소도 직접 입력한다.
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
        if (settings?.ServerUrl == null)
        {
            return;
        }

        _serverBox.Text = settings.ServerUrl;
        _serverBox.Visible = false;
    }

    private sealed class ConnectionSettings
    {
        public string? ServerUrl { get; set; }
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

            var code = _codeBox.Text.Trim();
            if (code.Length != 6 || !code.All(char.IsAsciiDigit))
            {
                MessageBox.Show("디스코드에서 /start를 입력해 받은 6자리 접속 코드를 입력해주세요.");
                return;
            }

            _cts = new CancellationTokenSource();
            _relayTask = RunRelayAsync(entry, _serverBox.Text, code, _cts.Token);

            _startStopButton.Text = "중지";
            _processList.Enabled = false;
            _serverBox.Enabled = false;
            _codeBox.Enabled = false;
            _refreshButton.Enabled = false;
        }
        else
        {
            _cts?.Cancel();
            ResetRelayUi();
            SetStatus("중지됨");
        }
    }

    private void ResetRelayUi()
    {
        _relayTask = null;
        _startStopButton.Text = "시작";
        _processList.Enabled = true;
        _serverBox.Enabled = true;
        _codeBox.Enabled = true;
        _refreshButton.Enabled = true;
    }

    private async Task RunRelayAsync(ProcessEntry entry, string serverUrl, string code, CancellationToken token)
    {
        int? serverCloseCode = null;
        try
        {
            SetStatus($"'{entry.Name}' 연결 중...");

            using var socket = new ClientWebSocket();
            await socket.ConnectAsync(new Uri(serverUrl), token);

            var authJson = JsonSerializer.Serialize(new { code });
            await socket.SendAsync(Encoding.UTF8.GetBytes(authJson), WebSocketMessageType.Text, endOfMessage: true, token);

            // 서버가 연결을 닫으면(인증 실패, 이미 다른 클라이언트 연결됨 등) 전송 루프를 멈추고 이유를 보여준다.
            // 수신 대기를 걸어둬야 서버의 ping에도 응답한다.
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token);
            var closeWatcher = WatchForServerCloseAsync(socket, linked);

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

            try
            {
                while (await timer.WaitForNextTickAsync(linked.Token))
                {
                    int bytesRead = pcm16Provider.Read(readBuffer.AsSpan());
                    if (bytesRead > 0)
                    {
                        agc.Process(readBuffer, bytesRead);
                        await socket.SendAsync(
                            new ArraySegment<byte>(readBuffer, 0, bytesRead),
                            WebSocketMessageType.Binary,
                            endOfMessage: true,
                            linked.Token);
                    }
                }
            }
            catch (Exception ex) when ((ex is OperationCanceledException && !token.IsCancellationRequested) || ex is WebSocketException)
            {
                // 서버가 연결을 닫았거나 끊어짐 (사용자가 직접 중지한 경우는 아래 바깥 catch로 간다)
                linked.Cancel();
            }

            serverCloseCode = await closeWatcher;
        }
        catch (OperationCanceledException)
        {
            // 사용자가 중지함
        }
        catch (Exception ex)
        {
            SetStatus($"오류: {ex.Message}");
        }

        if (serverCloseCode != null && !token.IsCancellationRequested)
        {
            SetStatus(DescribeServerClose(serverCloseCode.Value));
            BeginInvoke(ResetRelayUi);
        }
    }

    // 서버가 close 프레임을 보내면 그 코드를, 프레임 없이 끊어지면 0을 돌려준다. 사용자가 중지한 경우에는 null.
    private static async Task<int?> WatchForServerCloseAsync(ClientWebSocket socket, CancellationTokenSource linked)
    {
        var buffer = new byte[256];
        try
        {
            while (true)
            {
                var result = await socket.ReceiveAsync(buffer, linked.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    linked.Cancel();
                    return (int?)result.CloseStatus ?? 0;
                }
            }
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (WebSocketException)
        {
            linked.Cancel();
            return 0;
        }
    }

    private static string DescribeServerClose(int code) => code switch
    {
        4001 => "서버가 인증 메시지를 받지 못했습니다. 다시 시도해주세요.",
        4003 => "접속 코드가 올바르지 않거나 만료되었습니다. 디스코드에서 /start를 다시 입력해 새 코드를 받아주세요. (프로그램이 예전 버전이면 새 실행 파일을 받아주세요)",
        4004 => "활성화된 릴레이 세션이 없습니다. 먼저 디스코드에서 /start를 실행해주세요.",
        4005 => "이미 다른 오디오 클라이언트가 연결되어 있습니다. 한 번에 하나만 연결할 수 있어요.",
        4006 => "인증 실패가 너무 많아 잠시 접속이 차단되었습니다. 잠시 후 다시 시도해주세요.",
        0 => "서버와의 연결이 끊어졌습니다.",
        _ => $"서버가 연결을 종료했습니다. (코드 {code})",
    };

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
