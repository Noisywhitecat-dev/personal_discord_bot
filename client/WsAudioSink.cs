using System.Net.WebSockets;

namespace AudioRelayClient;

internal sealed class WsAudioSink : IAsyncDisposable
{
    private readonly ClientWebSocket _socket;

    private WsAudioSink(ClientWebSocket socket)
    {
        _socket = socket;
    }

    public static async Task<WsAudioSink> ConnectAsync(string serverUrl)
    {
        var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri(serverUrl), CancellationToken.None);
        Console.Error.WriteLine($"WebSocket 서버에 연결됨: {serverUrl}");
        return new WsAudioSink(socket);
    }

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
        if (_socket.State == WebSocketState.Open)
        {
            await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        }
        _socket.Dispose();
    }
}
