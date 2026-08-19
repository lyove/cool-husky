declare module 'audiobuffer-to-wav' {
  interface AudioBufferToWavOptions {
    /**
     * Output 32-bit float PCM instead of the default 16-bit integer PCM.
     * The underlying library only reads this field; sampleRate and channel
     * count come from the AudioBuffer itself.
     */
    float32?: boolean;
  }
  /**
   * Encode a Web Audio API AudioBuffer as a WAV ArrayBuffer.
   * Stereo buffers are interleaved; mono buffers use channel 0 directly.
   * Returns a 44-byte-header WAV (16-bit PCM by default, or 32-bit float).
   */
  export default function audioBufferToWav(
    buffer: AudioBuffer,
    options?: AudioBufferToWavOptions
  ): ArrayBuffer;
}
