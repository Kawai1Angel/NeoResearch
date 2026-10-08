// Periods are measured in observations, not calendar days. A high short-lag
// correlation alone is persistence; require a positive peak after detrending.
function mean(values: readonly number[]) {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0
}

function variance(values: readonly number[]) {
  const avg = mean(values)
  return mean(values.filter(Number.isFinite).map((value) => (value - avg) ** 2))
}

function correlation(values: readonly number[], lag: number) {
  let count = 0
  let mx = 0
  let my = 0
  let xx = 0
  let yy = 0
  let xy = 0
  for (let index = lag; index < values.length; index++) {
    const x = values[index]!
    const y = values[index - lag]!
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    count++
    const dx = x - mx
    const dy = y - my
    mx += dx / count
    my += dy / count
    xx += dx * (x - mx)
    yy += dy * (y - my)
    xy += dx * (y - my)
  }
  return count >= 3 && xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0
}

export function seasonalTrend(values: readonly number[], period: number) {
  const sums = [0]
  const counts = [0]
  for (const value of values) {
    sums.push(sums[sums.length - 1]! + (Number.isFinite(value) ? value : 0))
    counts.push(counts[counts.length - 1]! + Number(Number.isFinite(value)))
  }
  const left = Math.floor(period / 2)
  return values.map((_, index) => {
    const start = index - left
    const end = start + period
    if (start < 0 || end > values.length) return Number.NaN
    const count = counts[end]! - counts[start]!
    return count >= period * 0.8 ? (sums[end]! - sums[start]!) / count : Number.NaN
  })
}

function candidatePeriods(length: number, timestamps?: readonly number[]) {
  const periods = new Set([7, 12, 24, 48, 96])
  if (timestamps && timestamps.length >= 3) {
    const deltas = timestamps
      .slice(1)
      .map((value, index) => value - timestamps[index]!)
      .filter((value) => Number.isFinite(value) && value > 0)
    const sorted = deltas.toSorted((a, b) => a - b)
    const cadence = sorted[Math.floor(sorted.length / 2)]
    if (
      cadence &&
      deltas.length === timestamps.length - 1 &&
      deltas.filter((value) => Math.abs(value / cadence - 1) > 0.05).length / deltas.length <= 0.01
    ) {
      for (const days of [1, 7, 30, 365]) {
        const observations = (days * 86_400_000) / cadence
        if (Math.abs(observations - Math.round(observations)) < 0.01) periods.add(Math.round(observations))
      }
    }
  }
  return [...periods].filter((period) => period >= 3 && period * 3 <= length).toSorted((a, b) => a - b)
}

export function analyzeSeasonality(matrix: readonly (readonly number[])[], timestamps?: readonly number[]) {
  const columns = Array.from({ length: matrix[0]?.length ?? 0 }, (_, index) =>
    matrix.map((row) => row[index] ?? Number.NaN),
  )
  const candidates = candidatePeriods(matrix.length, timestamps).map((period) => {
    const strengths = columns.map((values) => {
      const trend = seasonalTrend(values, period)
      const residual = values.map((value, index) => value - trend[index]!)
      if (variance(residual) <= variance(values) * 1e-10) return 0
      const peak = correlation(residual, period)
      const distance = Math.max(1, Math.round(period / 4))
      const shoulder = Math.max(correlation(residual, period - distance), correlation(residual, period + distance))
      return peak >= 0.2 && peak - shoulder >= 0.1 ? peak : 0
    })
    return { period, strength: mean(strengths) }
  })
  const best = Math.max(0, ...candidates.map((item) => item.strength))
  // Prefer the fundamental period over a near-tied multiple of that period.
  const selected = candidates.find((item) => item.strength >= 0.2 && item.strength >= best - 0.03)
  return { strength: selected?.strength ?? best, period: selected?.period }
}

export function decomposeSeasonality(matrix: readonly (readonly number[])[], period: number | undefined) {
  if (period === undefined || period < 3 || period * 3 > matrix.length) return {}
  const shares = Array.from({ length: matrix[0]?.length ?? 0 }, (_, col) => {
    const values = matrix.map((row) => row[col] ?? Number.NaN)
    const trend = seasonalTrend(values, period)
    const detrended = values.map((value, index) => value - trend[index]!)
    const sums = Array<number>(period).fill(0)
    const counts = Array<number>(period).fill(0)
    detrended.forEach((value, index) => {
      if (!Number.isFinite(value)) return
      sums[index % period]! += value
      counts[index % period]!++
    })
    const seasonal = detrended.map((value, index) =>
      Number.isFinite(value) ? sums[index % period]! / Math.max(1, counts[index % period]!) : Number.NaN,
    )
    const residual = detrended.map((value, index) => value - seasonal[index]!)
    const total = variance(values.filter((_, index) => Number.isFinite(trend[index])))
    return total > 0 ? [variance(trend) / total, variance(seasonal) / total, variance(residual) / total] : undefined
  }).filter((item) => item !== undefined)
  if (!shares.length) return {}
  return {
    period,
    trendVarianceShare: mean(shares.map((item) => item[0]!)),
    seasonalVarianceShare: mean(shares.map((item) => item[1]!)),
    residualVarianceShare: mean(shares.map((item) => item[2]!)),
  }
}
