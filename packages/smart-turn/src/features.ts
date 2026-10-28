/**
 * Whisper log-mel features, as Hugging Face's `WhisperFeatureExtractor`
 * computes them with `do_normalize=True`: 80 mel bins, a 400-sample Hann
 * window and a 160-sample hop at 16 kHz.
 *
 * @module smart-turn/features
 */

const N_FFT = 400;
const HOP = 160;
const MEL_BINS = 80;
const FREQUENCY_BINS = N_FFT / 2 + 1;
const SAMPLE_RATE = 16000;

/** Slaney's mel scale: linear below 1 kHz, logarithmic above. */
function hertzToMel(hertz: number): number {
  if (hertz < 1000) return (3 * hertz) / 200;
  return 15 + Math.log(hertz / 1000) * (27 / Math.log(6.4));
}

function melToHertz(mel: number): number {
  if (mel < 15) return (200 * mel) / 3;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
}

/** Triangular filters with Slaney area normalization, stored sparsely per mel bin. */
function melFilters(): { start: number; weights: Float64Array }[] {
  const maxMel = hertzToMel(SAMPLE_RATE / 2);
  const edges = Array.from({ length: MEL_BINS + 2 }, (_, index) =>
    melToHertz((maxMel * index) / (MEL_BINS + 1)),
  );
  return Array.from({ length: MEL_BINS }, (_, mel) => {
    const [lower, center, upper] = [edges[mel] ?? 0, edges[mel + 1] ?? 0, edges[mel + 2] ?? 0];
    const norm = 2 / (upper - lower);
    const weights = new Float64Array(FREQUENCY_BINS);
    let start = FREQUENCY_BINS;
    let end = 0;
    for (let bin = 0; bin < FREQUENCY_BINS; bin++) {
      const hertz = (bin * SAMPLE_RATE) / N_FFT;
      const weight = Math.max(
        0,
        Math.min((hertz - lower) / (center - lower), (upper - hertz) / (upper - center)),
      );
      if (weight > 0) {
        weights[bin] = weight * norm;
        start = Math.min(start, bin);
        end = bin + 1;
      }
    }
    return { start, weights: weights.slice(start, Math.max(start, end)) };
  });
}

function smallestFactor(n: number): number {
  for (let factor = 2; factor * factor <= n; factor++) if (n % factor === 0) return factor;
  return n;
}

/**
 * In-place mixed-radix FFT of `size` points: the 400-point window is not a
 * power of two (400 = 2^4 * 5^2).
 */
function createFFT(size: number) {
  const cos = Float64Array.from({ length: size }, (_, index) =>
    Math.cos((-2 * Math.PI * index) / size),
  );
  const sin = Float64Array.from({ length: size }, (_, index) =>
    Math.sin((-2 * Math.PI * index) / size),
  );
  const tempRe = new Float64Array(size);
  const tempIm = new Float64Array(size);

  const transform = (
    inRe: Float64Array,
    inIm: Float64Array,
    inStart: number,
    stride: number,
    n: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outStart: number,
  ): void => {
    if (n === 1) {
      outRe[outStart] = inRe[inStart] ?? 0;
      outIm[outStart] = inIm[inStart] ?? 0;
      return;
    }
    const radix = smallestFactor(n);
    const m = n / radix;
    for (let q = 0; q < radix; q++) {
      transform(
        inRe,
        inIm,
        inStart + q * stride,
        stride * radix,
        m,
        outRe,
        outIm,
        outStart + q * m,
      );
    }
    const step = size / n;
    for (let k = 0; k < m; k++) {
      for (let q = 0; q < radix; q++) {
        const index = outStart + q * m + k;
        const twiddle = (q * k * step) % size;
        const re = outRe[index] ?? 0;
        const im = outIm[index] ?? 0;
        tempRe[q] = re * (cos[twiddle] ?? 0) - im * (sin[twiddle] ?? 0);
        tempIm[q] = re * (sin[twiddle] ?? 0) + im * (cos[twiddle] ?? 0);
      }
      for (let s = 0; s < radix; s++) {
        let re = 0;
        let im = 0;
        for (let q = 0; q < radix; q++) {
          const twiddle = (q * s * m * step) % size;
          re += (tempRe[q] ?? 0) * (cos[twiddle] ?? 0) - (tempIm[q] ?? 0) * (sin[twiddle] ?? 0);
          im += (tempRe[q] ?? 0) * (sin[twiddle] ?? 0) + (tempIm[q] ?? 0) * (cos[twiddle] ?? 0);
        }
        outRe[outStart + s * m + k] = re;
        outIm[outStart + s * m + k] = im;
      }
    }
  };

  const zeros = new Float64Array(size);
  const outRe = new Float64Array(size);
  const outIm = new Float64Array(size);
  return (input: Float64Array) => {
    transform(input, zeros, 0, 1, size, outRe, outIm, 0);
    return { re: outRe, im: outIm };
  };
}

const FILTERS = melFilters();
const WINDOW = Float64Array.from(
  { length: N_FFT },
  (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / N_FFT),
);
const fft = createFFT(N_FFT);

/** Reflects out-of-range indices, as `np.pad(mode="reflect")` does. */
function reflect(index: number, length: number): number {
  if (index < 0) return -index;
  if (index >= length) return 2 * (length - 1) - index;
  return index;
}

/**
 * Log-mel features of `samples` (16 kHz), shaped [80 mel bins][frames] and
 * flattened row by row. Like Whisper, the last STFT frame is dropped, so N
 * samples give N / 160 frames.
 */
export function whisperFeatures(samples: Float32Array): Float32Array {
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length || 1;
  let variance = 0;
  for (const sample of samples) variance += (sample - mean) ** 2;
  variance /= samples.length || 1;
  const scale = 1 / Math.sqrt(variance + 1e-7);

  const frames = Math.floor(samples.length / HOP);
  const logMel = new Float64Array(MEL_BINS * frames);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(FREQUENCY_BINS);
  let max = -Infinity;

  for (let index = 0; index < frames; index++) {
    const start = index * HOP - N_FFT / 2;
    for (let offset = 0; offset < N_FFT; offset++) {
      const sample = samples[reflect(start + offset, samples.length)] ?? 0;
      frame[offset] = (sample - mean) * scale * (WINDOW[offset] ?? 0);
    }
    const { re, im } = fft(frame);
    for (let bin = 0; bin < FREQUENCY_BINS; bin++) {
      power[bin] = (re[bin] ?? 0) ** 2 + (im[bin] ?? 0) ** 2;
    }
    for (let mel = 0; mel < MEL_BINS; mel++) {
      const filter = FILTERS[mel];
      if (!filter) continue;
      let energy = 0;
      for (let bin = 0; bin < filter.weights.length; bin++) {
        energy += (filter.weights[bin] ?? 0) * (power[filter.start + bin] ?? 0);
      }
      const value = Math.log10(Math.max(energy, 1e-10));
      logMel[mel * frames + index] = value;
      if (value > max) max = value;
    }
  }

  const features = new Float32Array(logMel.length);
  for (let index = 0; index < logMel.length; index++) {
    features[index] = (Math.max(logMel[index] ?? 0, max - 8) + 4) / 4;
  }
  return features;
}
