import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  Actor,
  CrackFormInput,
  CrackReviewInput,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const CRACK_STATUSES = ['待观测', '稳定', '持续变宽', '已封填']
const CRACK_TARGET_BY_ACTION: Record<string, string> = {
  提交观测: '稳定',
  标记变宽: '持续变宽',
  登记封填: '已封填',
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function succeed(message: string): ActionResult {
  return { ok: true, message }
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function normalizeStrike(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s　]/g, '')
    .replace(/NE/g, '北东')
    .replace(/NW/g, '北西')
}

function findHazard(hazardNo: string): EntryRow | undefined {
  return listRows('hazard').find((row) => String(row['隐患编号']) === hazardNo.trim())
}

function findCrack(id: number): { rows: EntryRow[]; index: number; row: EntryRow } | ActionResult {
  const rows = listRows('crack')
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的裂缝观测记录`)
  }
  return { rows, index, row: rows[index] }
}

// 冲突判定优先级：封填只读 > 跨片区 > 非责任观测人。跨片区只退回，不写入任何字段。
function assertSequentialStatus(current: string, action: string): ActionResult | string {
  const target = CRACK_TARGET_BY_ACTION[action]
  if (!target) {
    return fail(`裂缝观测记录没有登记「${action}」这个动作`)
  }
  const currentIndex = CRACK_STATUSES.indexOf(current)
  const targetIndex = CRACK_STATUSES.indexOf(target)
  if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
    const next = CRACK_STATUSES[currentIndex + 1] ?? CRACK_STATUSES[0]
    return fail(`状态流转已拦截：${current}只能先流转到「${next}」，不能越级到「${target}」`)
  }
  return target
}

function readCrackWidth(value: string): number | ActionResult {
  const text = value.trim()
  if (!/^\d+\.\d{2}$/.test(text)) {
    return fail('提交已退回：本期宽度必须为非负数字且保留两位小数（如 3.20），本次数据未落库')
  }
  return Number(text)
}

function assertCrackSubmission(
  row: EntryRow,
  actor: Actor,
  strike: string,
): ActionResult | { area: string; observer: string } {
  if (String(row.status) === '已封填') {
    return fail('裂缝已封填，记录已转为只读，不能再修改裂缝走向或本期宽度')
  }

  const hazardNo = String(row['所属隐患点'])
  const hazard = findHazard(hazardNo)
  if (!hazard) {
    return fail(`提交已退回：裂缝归属的隐患点「${hazardNo}」未建档，无法确认责任观测人`)
  }

  const ownerArea = String(hazard['责任片区'])
  const ownerName = String(hazard['责任观测人'])
  if (actor.area !== ownerArea) {
    return fail(`跨片区提交已退回：当前提交人属「${actor.area}」，${hazardNo}归属「${ownerArea}」；该裂缝仅由责任观测人维护`)
  }
  if (actor.name !== ownerName) {
    return fail(`提交已退回：${hazardNo}归属责任观测人「${ownerName}」，当前操作人「${actor.name}」不能改动`)
  }

  // 同一裂缝在裂缝观测、隐患点建档两处都要翻一遍；建档记录优先级更高。
  const archiveStrike = String(hazard['档案裂缝走向'])
  if (normalizeStrike(strike) !== normalizeStrike(archiveStrike)) {
    return fail(`提交已退回：裂缝走向与隐患点建档不一致；档案以「${archiveStrike}」为准（建档记录优先），请校正后再提交`)
  }
  return { area: ownerArea, observer: ownerName }
}

function saveCrack(rows: EntryRow[], index: number, row: EntryRow): void {
  const next = [...rows]
  next[index] = row
  saveRows('crack', next)
}

export function listHazardOptions(): EntryRow[] {
  return listRows('hazard')
}

export function createCrackRecord(input: CrackFormInput, actor: Actor): ActionResult {
  const crackNo = input.crackNo.trim()
  const hazardNo = input.hazardNo.trim()
  const strike = input.strike.trim()
  const observationDate = input.observationDate.trim()

  if (!crackNo || !hazardNo || !strike || !input.currentWidth.trim() || !observationDate) {
    return fail('登记已退回：裂缝编号、所属隐患点、裂缝走向、本期宽度、观测日期必须完整')
  }
  if (listRows('crack').some((row) => String(row['裂缝编号']) === crackNo)) {
    return fail(`登记已退回：裂缝编号「${crackNo}」已存在，不能重复建档`)
  }

  const hazard = findHazard(hazardNo)
  if (!hazard) {
    return fail(`登记已退回：所属隐患点「${hazardNo}」未建档，无法完成归属收口`)
  }
  const ownerArea = String(hazard['责任片区'])
  const ownerName = String(hazard['责任观测人'])
  if (actor.area !== ownerArea) {
    return fail(`跨片区提交已退回：当前提交人属「${actor.area}」，${hazardNo}归属「${ownerArea}」；不能跨片区登记`)
  }
  if (actor.name !== ownerName) {
    return fail(`登记已退回：${hazardNo}归属责任观测人「${ownerName}」，当前操作人「${actor.name}」不能登记`)
  }

  const archiveStrike = String(hazard['档案裂缝走向'])
  if (normalizeStrike(strike) !== normalizeStrike(archiveStrike)) {
    return fail(`登记已退回：裂缝走向与隐患点建档不一致；档案以「${archiveStrike}」为准（建档记录优先）`)
  }
  const width = readCrackWidth(input.currentWidth)
  if (typeof width !== 'number') return width

  const rows = listRows('crack')
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const widthValue = width
  const row: EntryRow = {
    id,
    status: '待观测',
    pending: true,
    abnormal: false,
    裂缝编号: crackNo,
    所属隐患点: hazardNo,
    责任片区: ownerArea,
    责任观测人: ownerName,
    裂缝走向: strike,
    本期宽度: widthValue.toFixed(2),
    初始宽度: widthValue.toFixed(2),
    累计变宽: '0.00',
    观测日期: observationDate,
    观测人: ownerName,
    封填日期: '',
    复核人: '',
    复核日期: '',
    复核结论: '',
    裂缝状态: '待观测',
  }
  saveRows('crack', [...rows, row])
  return succeed(`裂缝「${crackNo}」已归属到${hazardNo}，责任观测人为「${ownerName}」`)
}

export function submitCrackObservation(id: number, input: CrackFormInput, actor: Actor): ActionResult {
  const found = findCrack(id)
  if ('ok' in found) return found
  const { rows, index, row } = found
  const owner = assertCrackSubmission({ ...row, 裂缝走向: input.strike }, actor, input.strike)
  if ('ok' in owner) return owner
  const widthResult = readCrackWidth(input.currentWidth)
  if (typeof widthResult !== 'number') return widthResult

  const target = assertSequentialStatus(String(row.status), '提交观测')
  if (typeof target !== 'string') return target

  const initial = Number(row['初始宽度'])
  const cumulative = Math.max(0, widthResult - initial)
  saveCrack(rows, index, {
    ...row,
    status: target,
    pending: target !== CRACK_STATUSES[CRACK_STATUSES.length - 1],
    abnormal: false,
    责任片区: owner.area,
    责任观测人: owner.observer,
    裂缝走向: input.strike.trim(),
    本期宽度: widthResult.toFixed(2),
    累计变宽: cumulative.toFixed(2),
    观测日期: input.observationDate.trim() || todayText(),
    观测人: actor.name,
    裂缝状态: target,
  })
  return succeed(`观测已提交，裂缝「${row['裂缝编号']}」当前状态「${target}」`)
}

export function markCrackWidening(id: number, input: CrackFormInput, actor: Actor): ActionResult {
  const found = findCrack(id)
  if ('ok' in found) return found
  const { rows, index, row } = found
  const owner = assertCrackSubmission({ ...row, 裂缝走向: input.strike }, actor, input.strike)
  if ('ok' in owner) return owner
  const widthResult = readCrackWidth(input.currentWidth)
  if (typeof widthResult !== 'number') return widthResult

  const target = assertSequentialStatus(String(row.status), '标记变宽')
  if (typeof target !== 'string') return target

  const previousWidth = Number(row['本期宽度'])
  if (widthResult <= previousWidth) {
    return fail(`标记已退回：本期宽度 ${widthResult.toFixed(2)} 未大于上期 ${previousWidth.toFixed(2)}，不能判定为持续变宽；数据未落库`)
  }

  const initial = Number(row['初始宽度'])
  saveCrack(rows, index, {
    ...row,
    status: target,
    pending: true,
    abnormal: true,
    责任片区: owner.area,
    责任观测人: owner.observer,
    裂缝走向: input.strike.trim(),
    本期宽度: widthResult.toFixed(2),
    累计变宽: Math.max(0, widthResult - initial).toFixed(2),
    观测日期: input.observationDate.trim() || todayText(),
    观测人: actor.name,
    裂缝状态: target,
  })
  return succeed(`裂缝「${row['裂缝编号']}」已标记为「${target}」`)
}

export function sealCrack(id: number, actor: Actor): ActionResult {
  const found = findCrack(id)
  if ('ok' in found) return found
  const { rows, index, row } = found

  const hazard = findHazard(String(row['所属隐患点']))
  if (!hazard) {
    return fail(`封填已退回：裂缝归属的隐患点「${row['所属隐患点']}」未建档`)
  }
  const ownerArea = String(hazard['责任片区'])
  const ownerName = String(hazard['责任观测人'])
  if (actor.area !== ownerArea) {
    return fail(`跨片区提交已退回：当前提交人属「${actor.area}」，该裂缝归属「${ownerArea}」，不能办理封填`)
  }
  if (actor.name !== ownerName) {
    return fail(`封填已退回：仅责任观测人「${ownerName}」可办理，当前操作人「${actor.name}」无权操作`)
  }

  const target = assertSequentialStatus(String(row.status), '登记封填')
  if (typeof target !== 'string') return target

  saveCrack(rows, index, {
    ...row,
    status: target,
    pending: false,
    abnormal: false,
    责任片区: ownerArea,
    责任观测人: ownerName,
    封填日期: todayText(),
    裂缝状态: target,
  })
  return succeed(`裂缝「${row['裂缝编号']}」已封填并转为只读`)
}

export function reviewSealedCrack(id: number, input: CrackReviewInput, actor: Actor): ActionResult {
  const found = findCrack(id)
  if ('ok' in found) return found
  const { rows, index, row } = found

  if (String(row.status) !== '已封填') {
    return fail(`复核已退回：仅已封填裂缝可复核，当前状态为「${row.status}」`)
  }

  const hazardRows = listRows('hazard')
  const hazardIndex = hazardRows.findIndex((item) => String(item['隐患编号']) === String(row['所属隐患点']))
  if (hazardIndex < 0) {
    return fail(`复核已退回：裂缝归属的隐患点「${row['所属隐患点']}」未建档`)
  }
  const hazard = hazardRows[hazardIndex]
  const ownerArea = String(hazard['责任片区'])
  const ownerName = String(hazard['责任观测人'])
  if (actor.area !== ownerArea) {
    return fail(`跨片区复核已退回：当前提交人属「${actor.area}」，该裂缝归属「${ownerArea}」`)
  }
  if (actor.name !== ownerName) {
    return fail(`复核已退回：仅责任观测人「${ownerName}」可提交，当前操作人「${actor.name}」无权操作`)
  }
  if (normalizeStrike(String(row['裂缝走向'])) !== normalizeStrike(String(hazard['档案裂缝走向']))) {
    return fail(`复核已退回：裂缝走向与隐患点建档不一致；档案以「${hazard['档案裂缝走向']}」为准（建档记录优先）`)
  }
  if (String(row['复核结论']).trim()) {
    return fail(`重复复核已退回：裂缝「${row['裂缝编号']}」已有 ${row['复核日期']} 的最早复核结论，只保留最早那份`)
  }

  const reviewDate = input.reviewDate.trim() || todayText()
  const updatedCrack: EntryRow = {
    ...row,
    责任片区: ownerArea,
    责任观测人: ownerName,
    复核人: actor.name,
    复核日期: reviewDate,
    复核结论: input.conclusion,
  }

  const updatedHazard: EntryRow = { ...hazard }
  let clearanceCreated = false
  let nextClearanceRows: EntryRow[] | null = null
  const todoToken = `待核销：裂缝${String(row['裂缝编号'])}封填复核`
  const currentTodos = String(hazard['待办事项'] ?? '').split('；').map((item) => item.trim()).filter(Boolean)

  if (input.conclusion === '建议核销') {
    if (!currentTodos.includes(todoToken)) currentTodos.push(todoToken)
    updatedHazard['待办事项'] = currentTodos.join('；')
    updatedHazard.pending = true

    const clearanceRows = listRows('clearance')
    const clearanceId = clearanceRows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1
    const clearanceRow: EntryRow = {
      id: clearanceId,
      status: '待核销',
      pending: true,
      abnormal: false,
      核销编号: `CLEA-${String(clearanceId).padStart(4, '0')}`,
      所属隐患点: String(hazard['隐患编号']),
      核销依据: `裂缝${String(row['裂缝编号'])}封填复核`,
      复核人: actor.name,
      复核日期: reviewDate,
      核销结论: '建议核销',
      归档日期: '',
      核销状态: '待核销',
    }
    nextClearanceRows = [...clearanceRows, clearanceRow]
    clearanceCreated = true
  } else {
    updatedHazard['待办事项'] = currentTodos.filter((item) => item !== todoToken).join('；')
  }

  const nextHazards = [...hazardRows]
  nextHazards[hazardIndex] = updatedHazard
  const nextCracks = rows.map((item, itemIndex) => (itemIndex === index ? updatedCrack : item))
  saveAll({
    ...allRows(),
    hazard: nextHazards,
    crack: nextCracks,
    ...(nextClearanceRows ? { clearance: nextClearanceRows } : {}),
  })

  return succeed(
    clearanceCreated
      ? `复核已保存：建议核销已写入${hazard['隐患编号']}建档待办，并生成待核销项`
      : '复核已保存：结论为继续观测，未生成待核销项',
  )
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return fail(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return fail(`${meta.entity}已经是「${target}」，不用重复操作`)
  }

  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)

  // 隐患建档待办里冒出的“待核销”项，可直接确认核销；其余模块仍必须逐级流转。
  const skipSequence = key === 'clearance' && current === '待核销' && action === '确认核销'
  if (
    !skipSequence &&
    currentIndex >= 0 &&
    targetIndex >= 0 &&
    targetIndex !== currentIndex + 1
  ) {
    const next = meta.statuses[currentIndex + 1] ?? meta.statuses[0]
    return fail(`状态流转已拦截：${current}只能先流转到「${next}」，不能越级到「${target}」`)
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return succeed(`${meta.entity}已${action}，当前状态「${target}」`)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
