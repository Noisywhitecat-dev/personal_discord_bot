using System.Text;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

Console.OutputEncoding = Encoding.UTF8;

Console.Error.WriteLine("클라이언트 시작");

var targetFormat = new WaveFormat(48000, 16, 2);

using var capture = new WasapiLoopbackCapture();

var buffered = new BufferedWaveProvider(capture.WaveFormat)
{
    BufferDuration = TimeSpan.FromSeconds(5),
    DiscardOnBufferOverflow = true,
};

ISampleProvider sampleProvider = buffered.ToSampleProvider();

if (capture.WaveFormat.Channels == 1 && targetFormat.Channels == 2)
{
    sampleProvider = new MonoToStereoSampleProvider(sampleProvider);
}

if (sampleProvider.WaveFormat.SampleRate != targetFormat.SampleRate)
{
    sampleProvider = new WdlResamplingSampleProvider(sampleProvider, targetFormat.SampleRate);
}

var pcm16Provider = sampleProvider.ToWaveProvider16();

capture.DataAvailable += (_, e) =>
{
    buffered.AddSamples(e.Buffer, 0, e.BytesRecorded);
};

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

using var stdout = Console.OpenStandardOutput();
var readBuffer = new byte[pcm16Provider.WaveFormat.AverageBytesPerSecond / 10];

while (true)
{
    int bytesRead = pcm16Provider.Read(readBuffer, 0, readBuffer.Length);
    if (bytesRead > 0)
    {
        stdout.Write(readBuffer, 0, bytesRead);
        stdout.Flush();
    }
    else
    {
        Thread.Sleep(10);
    }
}
