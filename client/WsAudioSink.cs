using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace AudioRelayClient;

internal sealed class WsAudioSink : IAsyncDisposable
{
    private readonly ClientWebSocket _socket;
    private volatile bool _disposing;

    private WsAudioSink(ClientWebSocket socket)
    {
        _socket = socket;
    }

    public static async Task<WsAudioSink> ConnectAsync(string serverUrl, string? code)
    {
        var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri(serverUrl), CancellationToken.None);
        Console.Error.WriteLine($"WebSocket 서버에 연결됨: {serverUrl}");

        var authJson = JsonSerializer.Serialize(new { code = code ?? "" });
        await socket.SendAsync(Encoding.UTF8.GetBytes(authJson), WebSocketMessageType.Text, endOfMessage: true, CancellationToken.None);

        var sink = new WsAudioSink(socket);
        _ = sink.WatchForServerCloseAsync();
        return sink;
    }

    // 서버가 연결을 닫으면(close 프레임) 이유를 알려주고 종료한다. 수신 대기를 걸어둬야 서버의 ping에도 응답한다.
    private async Task WatchForServerCloseAsync()
    {
        var buffer = new byte[256];
        try
        {
            while (true)
            {
                var result = await _socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    if (!_disposing)
                    {
                        Console.Error.WriteLine(DescribeClose((int?)result.CloseStatus ?? 0));
                        Environment.Exit(1);
                    }
                    return;
                }
            }
        }
        catch (WebSocketException)
        {
            if (!_disposing)
            {
                Console.Error.WriteLine(DescribeClose(0));
                Environment.Exit(1);
            }
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private static string DescribeClose(int code) => code switch
    {
        4001 => "서버가 인증 메시지를 받지 못했습니다. 다시 시도해주세요.",
        4003 => "접속 코드가 올바르지 않거나 만료되었습니다. 디스코드에서 /start를 다시 입력해 새 코드를 받아주세요. (프로그램이 예전 버전이면 새 실행 파일을 받아주세요)",
        4004 => "활성화된 릴레이 세션이 없습니다. 먼저 디스코드에서 /start를 실행해주세요.",
        4005 => "이미 다른 오디오 클라이언트가 연결되어 있습니다. 한 번에 하나만 연결할 수 있어요.",
        4006 => "인증 실패가 너무 많아 잠시 접속이 차단되었습니다. 잠시 후 다시 시도해주세요.",
        0 => "서버와의 연결이 끊어졌습니다.",
        _ => $"서버가 연결을 종료했습니다. (코드 {code})",
    };

    public Task SendAsync(byte[] buffer, int count)
    {
        return _socket.SendAsync(
            new ArraySegment<byte>(buffer, 0, count),
            WebSocketMessageType.Binary,
            endOfMessage: true,
            CancellationToken.None);
    }

    public async ValueTask DisposeAsync()
    {
        _disposing = true;
        if (_socket.State == WebSocketState.Open)
        {
            await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        }
        _socket.Dispose();
    }
}
