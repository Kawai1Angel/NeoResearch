// Exact-length real-input DFT power via Bluestein convolution. This keeps
// per-column frequency diagnostics practical without truncating training data.
function fft(real: Float64Array, imag: Float64Array, inverse = false) {
  const size = real.length
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1
    while (reversed & bit) {
      reversed ^= bit
      bit >>= 1
    }
    reversed ^= bit
    if (index < reversed) {
      const realValue = real[index]!
      const imagValue = imag[index]!
      real[index] = real[reversed]!
      imag[index] = imag[reversed]!
      real[reversed] = realValue
      imag[reversed] = imagValue
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width
    const stepReal = Math.cos(angle)
    const stepImag = Math.sin(angle)
    for (let start = 0; start < size; start += width) {
      let phaseReal = 1
      let phaseImag = 0
      for (let offset = 0; offset < width / 2; offset++) {
        const left = start + offset
        const right = left + width / 2
        const r = real[right]! * phaseReal - imag[right]! * phaseImag
        const i = real[right]! * phaseImag + imag[right]! * phaseReal
        real[right] = real[left]! - r
        imag[right] = imag[left]! - i
        real[left]! += r
        imag[left]! += i
        const nextReal = phaseReal * stepReal - phaseImag * stepImag
        phaseImag = phaseReal * stepImag + phaseImag * stepReal
        phaseReal = nextReal
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index++) {
      real[index]! /= size
      imag[index]! /= size
    }
  }
}

export function spectralPowers(values: readonly number[]) {
  const count = values.length
  if (!count) return []
  let size = 1
  while (size < count * 2 - 1) size *= 2
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  const chirpReal = new Float64Array(size)
  const chirpImag = new Float64Array(size)
  for (let index = 0; index < count; index++) {
    const angle = (Math.PI * ((index * index) % (count * 2))) / count
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    real[index] = values[index]! * cos
    imag[index] = -values[index]! * sin
    chirpReal[index] = cos
    chirpImag[index] = sin
    if (index) {
      chirpReal[size - index] = cos
      chirpImag[size - index] = sin
    }
  }
  fft(real, imag)
  fft(chirpReal, chirpImag)
  for (let index = 0; index < size; index++) {
    const r = real[index]! * chirpReal[index]! - imag[index]! * chirpImag[index]!
    imag[index] = real[index]! * chirpImag[index]! + imag[index]! * chirpReal[index]!
    real[index] = r
  }
  fft(real, imag, true)
  return Array.from({ length: Math.floor(count / 2) }, (_, index) => {
    const k = index + 1
    return { period: count / k, power: real[k]! ** 2 + imag[k]! ** 2 }
  })
}
