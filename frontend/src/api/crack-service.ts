import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 裂缝观测归属收口：所有裂缝写入（观测登记/修改、状态流转、封填复核）都必须经过本文件，
// 页面层没有旁路。规则一旦不满足，一律只退回、不落库。

// 裂缝状态只能按这个顺序逐环流转，越级或回退一律挡下。
export const CRACK_FLOW: string[] = ['待观测', '稳定', '持续变宽', '已封填']
export const CRACK_FLOW_ACTION: Record<string, string> = {
  提交观测: '稳定',
  标记变宽: '持续变宽',
  登记封填: '已封填',
}
export const SEALED_STATUS = '已封填'

// 裂缝走向冲突时的判定优先级：封填后的裂缝档案最高，本期观测其次，复核填报最低。
// 排在前面的来源说了算，低优先级来源与它不一致时，以高优先级为准对齐。
export const TREND_PRIORITY = ['已封填裂缝档案', '本期观测记录', '复核填报'] as const

// 本期宽度只认到 0.1mm（一位小数）：精度不对直接退回，不让它落库。
const WIDTH_PATTERN = /^\d+(\.\d)?$/

export type Identity = {
  观测人: string
  片区: string
}

type Fail = ActionResult & { ok: false }

function fail(message: string): Fail {
  return { ok: false, message }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function hazards(): EntryRow[] {
  return listRows('hazard')
}

export function findHazard(code: string): EntryRow | undefined {
  return hazards().find((row) => String(row['隐患编号']) === code.trim())
}

export function findCrack(id: number): EntryRow | undefined {
  return listRows('crack').find((row) => Number(row.id) === id)
}

export function findCrackByCode(code: string): EntryRow | undefined {
  return listRows('crack').find((row) => String(row['裂缝编号']) === code.trim())
}

/** 本期宽度精度校验：非数字、负数、超过一位小数都判不合格。 */
export function validateWidth(raw: string): { ok: true; value: number } | Fail {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return fail('本期宽度不能为空')
  }
  if (!WIDTH_PATTERN.test(text)) {
    return fail(`本期宽度「${text}」精度不对：裂缝宽度只认到 0.1mm（一位小数），请修正后重新提交`)
  }
  return { ok: true, value: Number(text) }
}

function assertOwner(row: EntryRow, identity: Identity): { ok: true; hazard: EntryRow } | Fail {
  const hazardCode = String(row['所属隐患点'] ?? '').trim()
  const hazard = findHazard(hazardCode)
  if (!hazard) {
    return fail(`裂缝归属的隐患点「${hazardCode}」查不到建档记录，无法确认责任观测人，提交退回`)
  }
  const ownerArea = String(hazard['责任片区'] ?? '')
  const ownerName = String(hazard['责任观测人'] ?? '')
  if (identity.片区 !== ownerArea) {
    return fail(
      `跨片区提交被退回：${row['裂缝编号']} 落在隐患点 ${hazardCode}（${ownerArea}），` +
        `归该片区责任观测人「${ownerName}」维护，你所在的「${identity.片区}」不能改动`,
    )
  }
  if (identity.观测人 !== ownerName) {
    return fail(
      `提交被退回：${row['裂缝编号']} 归属隐患点 ${hazardCode} 的责任观测人「${ownerName}」维护，` +
        `观测人「${identity.观测人}」无权改动`,
    )
  }
  return { ok: true, hazard }
}

function persistCrack(next: EntryRow[]): void {
  saveRows('crack', next)
}

function nextCrackCode(rows: EntryRow[]): string {
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  return `CRAC-${String(maxId + 1).padStart(4, '0')}`
}

function nextClearanceCode(rows: EntryRow[]): string {
  let maxSeq = 0
  for (const row of rows) {
    const code = String(row['核销编号'] ?? '')
    const match = code.match(/CLEA-(\d+)/)
    if (match) {
      maxSeq = Math.max(maxSeq, Number(match[1]))
    }
  }
  return `CLEA-${String(maxSeq + 1).padStart(4, '0')}`
}

/** 同一裂缝是否已经有过复核结论（核销清单里挂着来源裂缝）。重复复核只认最早那份。 */
export function reviewExists(crackCode: string): EntryRow | undefined {
  return listRows('clearance').find(
    (row) => String(row['来源裂缝编号'] ?? '').trim() === crackCode.trim(),
  )
}

export type CrackRegisterInput = {
  所属隐患点: string
  裂缝走向: string
  本期宽度: string
  观测日期: string
}

/** 登记裂缝：编号落到隐患点即归该点责任人；跨片区登记同样退回；宽度精度先验。 */
export function registerCrack(input: CrackRegisterInput, identity: Identity): ActionResult {
  const hazardCode = input.所属隐患点?.trim() ?? ''
  if (!hazardCode) {
    return fail('请选择裂缝归属的隐患点')
  }
  const hazard = findHazard(hazardCode)
  if (!hazard) {
    return fail(`隐患点「${hazardCode}」未建档，裂缝不能挂到不存在的隐患点上`)
  }
  if (identity.片区 !== String(hazard['责任片区']) || identity.观测人 !== String(hazard['责任观测人'])) {
    return fail(
      `跨片区登记被退回：隐患点 ${hazardCode} 归「${hazard['责任片区']}」的「${hazard['责任观测人']}」维护，` +
        `你所在的「${identity.片区} / ${identity.观测人}」不能为其登记裂缝`,
    )
  }
  if (!input.裂缝走向?.trim()) {
    return fail('裂缝走向不能为空')
  }
  const width = validateWidth(input.本期宽度)
  if (!width.ok) {
    return width
  }

  const rows = listRows('crack')
  const row: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    status: '待观测',
    pending: true,
    abnormal: false,
    裂缝编号: nextCrackCode(rows),
    所属隐患点: hazardCode,
    所属片区: String(hazard['责任片区']),
    裂缝走向: input.裂缝走向.trim(),
    本期宽度: width.value,
    累计变宽: 0,
    观测日期: input.观测日期 || today(),
    观测人: identity.观测人,
    裂缝状态: '待观测',
  }
  persistCrack([...rows, row])
  return { ok: true, message: `裂缝 ${row.裂缝编号} 已登记，归属 ${hazardCode}，由${identity.观测人}维护` }
}

export type CrackObservationInput = {
  裂缝走向: string
  本期宽度: string
  观测日期: string
}

/** 修改裂缝走向/本期宽度：封填后只读，归属不对退回，宽度精度不对不落库。 */
export function saveObservation(
  id: number,
  input: CrackObservationInput,
  identity: Identity,
): ActionResult {
  const row = findCrack(id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的裂缝观测记录`)
  }
  if (String(row.status) === SEALED_STATUS) {
    return fail(`${row['裂缝编号']} 已封填，观测记录转为只读，裂缝走向与本期宽度都不能再改`)
  }
  const owner = assertOwner(row, identity)
  if (!owner.ok) {
    return owner
  }
  if (!input.裂缝走向?.trim()) {
    return fail('裂缝走向不能为空')
  }
  const width = validateWidth(input.本期宽度)
  if (!width.ok) {
    return width
  }

  const previousWidth = Number(row['本期宽度'] ?? 0) || 0
  const previousTotal = Number(row['累计变宽'] ?? 0) || 0
  const cumulative = +(previousTotal + Math.max(width.value - previousWidth, 0)).toFixed(1)

  const rows = listRows('crack')
  const index = rows.findIndex((item) => Number(item.id) === id)
  rows[index] = {
    ...row,
    裂缝走向: input.裂缝走向.trim(),
    本期宽度: width.value,
    累计变宽: cumulative,
    观测日期: input.观测日期 || today(),
  }
  persistCrack(rows)
  return { ok: true, message: `${row['裂缝编号']} 本期观测已保存，累计变宽 ${cumulative}mm` }
}

/** 状态流转：先查归属、封填只读，再校验必须逐环流转。 */
export function flowCrack(id: number, action: string, identity: Identity): ActionResult {
  const row = findCrack(id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的裂缝观测记录`)
  }
  const target = CRACK_FLOW_ACTION[action]
  if (!target) {
    return fail(`裂缝观测没有登记「${action}」这个动作`)
  }
  const owner = assertOwner(row, identity)
  if (!owner.ok) {
    return owner
  }

  const current = String(row.status)
  const currentIndex = CRACK_FLOW.indexOf(current)
  const targetIndex = CRACK_FLOW.indexOf(target)
  if (currentIndex === targetIndex) {
    return fail(`裂缝 ${row['裂缝编号']} 已经是「${target}」，不用重复操作`)
  }
  if (targetIndex !== currentIndex + 1) {
    return fail(
      `越级流转被挡下：裂缝状态只能按 ${CRACK_FLOW.join(' → ')} 依次流转，` +
        `不能从「${current}」直接${action}跳到「${target}」`,
    )
  }

  const rows = listRows('crack')
  const index = rows.findIndex((item) => Number(item.id) === id)
  rows[index] = {
    ...row,
    status: target,
    pending: target !== SEALED_STATUS,
    裂缝状态: target,
  }
  persistCrack(rows)
  const sealedTip = target === SEALED_STATUS ? '，记录已转为只读，可提交封填复核' : ''
  return { ok: true, message: `裂缝 ${row['裂缝编号']} 已${action}，当前状态「${target}」${sealedTip}` }
}

export type CrackReviewInput = {
  复核走向: string
  复核结论: string
}

/**
 * 封填复核：
 * - 只有已封填裂缝、且归属责任观测人能提交，跨片区直接退回；
 * - 重复复核只保留最早一份，再提一律退回；
 * - 复核走向与裂缝档案走向两处对一遍，冲突按优先级判定，档案为准并自动对齐；
 * - 结论落成隐患点的待核销项（隐患核销清单里冒出一张待复核核销单）。
 */
export function submitCrackReview(
  id: number,
  input: CrackReviewInput,
  identity: Identity,
): ActionResult {
  const row = findCrack(id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的裂缝观测记录`)
  }
  const code = String(row['裂缝编号'])
  if (String(row.status) !== SEALED_STATUS) {
    return fail(`裂缝 ${code} 尚未封填，不能提交封填复核；请先按顺序完成登记封填`)
  }
  const owner = assertOwner(row, identity)
  if (!owner.ok) {
    return owner
  }
  const existed = reviewExists(code)
  if (existed) {
    return fail(
      `重复复核被退回：裂缝 ${code} 已有最早一份复核（核销单 ${existed['核销编号']}，状态「${existed.status}」），只保留最早那份`,
    )
  }
  const reviewTrend = input.复核走向?.trim()
  if (!reviewTrend) {
    return fail('复核走向不能为空')
  }
  if (!input.复核结论?.trim()) {
    return fail('复核结论不能为空，结论要反映到隐患点建档待办')
  }

  // 两处翻一遍：裂缝档案走向 vs 复核填报走向。冲突时按优先级，已封填档案赢。
  const archivedTrend = String(row['裂缝走向'] ?? '').trim()
  let basis = `裂缝 ${code} 封填复核通过（走向：${archivedTrend}）`
  let note = ''
  if (reviewTrend !== archivedTrend) {
    note = `；走向冲突已按优先级（${TREND_PRIORITY.join('＞')}）以裂缝档案「${archivedTrend}」为准，复核填报的「${reviewTrend}」不采纳`
  }

  const clearanceRows = listRows('clearance')
  const clearance: EntryRow = {
    id: clearanceRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    status: '待复核',
    pending: true,
    abnormal: false,
    核销编号: nextClearanceCode(clearanceRows),
    所属隐患点: String(row['所属隐患点']),
    核销依据: basis,
    复核人: identity.观测人,
    复核日期: today(),
    核销结论: input.复核结论.trim(),
    归档日期: '',
    核销状态: '待复核',
    来源裂缝编号: code,
  }
  saveRows('clearance', [...clearanceRows, clearance])
  return {
    ok: true,
    message: `裂缝 ${code} 封填复核已受理，隐患点 ${clearance.所属隐患点} 的待核销项 ${clearance.核销编号} 已进入隐患核销清单${note}`,
  }
}

/**
 * 核销确认时再把两处走向翻一遍：核销依据里记的走向必须与裂缝档案一致。
 * 若历史数据对不上，仍按优先级以裂缝档案为准对齐，避免带着错档核销。
 */
export function crossCheckClearance(clearance: EntryRow): ActionResult {
  const code = String(clearance['来源裂缝编号'] ?? '').trim()
  if (!code) {
    return { ok: true, message: '' }
  }
  const crack = findCrackByCode(code)
  if (!crack) {
    return fail(`核销单关联的裂缝 ${code} 已找不到，无法核对走向，确认核销退回`)
  }
  const archivedTrend = String(crack['裂缝走向'] ?? '').trim()
  const basis = String(clearance['核销依据'] ?? '')
  const matched = basis.includes(`走向：${archivedTrend}`)
  if (matched) {
    return { ok: true, message: `；裂缝走向两处核对一致（${archivedTrend}）` }
  }
  const rows = listRows('clearance')
  const index = rows.findIndex((item) => Number(item.id) === Number(clearance.id))
  if (index >= 0) {
    rows[index] = {
      ...rows[index],
      核销依据: `裂缝 ${code} 封填复核通过（走向：${archivedTrend}）`,
    }
    saveRows('clearance', rows)
  }
  return {
    ok: true,
    message: `；走向冲突已按优先级以裂缝档案「${archivedTrend}」为准对齐后核销`,
  }
}
