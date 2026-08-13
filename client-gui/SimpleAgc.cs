namespace AudioRelayClientGui;

/// <summary>
/// 사람마다 다른 소스 볼륨을 목표 음량으로 맞추는 간단한 자동 게인 컨트롤(AGC).
/// 조용하면 서서히 키우고, 시끄러우면 빠르게 줄여서 재생 중 급격한 볼륨 변화를 막는다.
/// </summary>
internal sealed class SimpleAgc
{
    private const double TargetRms = 0.1;   // 목표 RMS (대략 -20 dBFS)
    private const double MaxGain = 6.0;
    private const double MinGain = 0.2;
    private const double AttackCoeff = 0.5;  // 게인을 줄일 때(소리가 클 때) 빠르게 반응
    private const double ReleaseCoeff = 0.05; // 게인을 키울 때(소리가 작을 때) 천천히 반응
    private const double SilenceThreshold = 0.0005; // 무음/노이즈까지 증폭하지 않도록

    private double _gain = 1.0;

    public void Process(byte[] buffer, int count)
    {
        int sampleCount = count / 2;
        if (sampleCount == 0)
        {
            return;
        }

        double sumSquares = 0;
        for (int i = 0; i + 1 < count; i += 2)
        {
            short sample = (short)(buffer[i] | (buffer[i + 1] << 8));
            double normalized = sample / 32768.0;
            sumSquares += normalized * normalized;
        }
        double rms = Math.Sqrt(sumSquares / sampleCount);

        if (rms > SilenceThreshold)
        {
            double desiredGain = Math.Clamp(TargetRms / rms, MinGain, MaxGain);
            double coeff = desiredGain < _gain ? AttackCoeff : ReleaseCoeff;
            _gain += (desiredGain - _gain) * coeff;
        }

        for (int i = 0; i + 1 < count; i += 2)
        {
            short sample = (short)(buffer[i] | (buffer[i + 1] << 8));
            double amplified = sample * _gain;
            short clipped = (short)Math.Clamp(amplified, short.MinValue, short.MaxValue);
            buffer[i] = (byte)(clipped & 0xFF);
            buffer[i + 1] = (byte)((clipped >> 8) & 0xFF);
        }
    }
}
