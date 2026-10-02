<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝观测管理</h2>
        <p class="page-desc">裂缝按所属隐患点归属到责任片区和责任观测人；封填后只读，状态按环节依次流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item lock-note">当前提交人：{{ store.area }} · {{ store.operator }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table crack-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            {{ displayValue(row, column) }}
            <span v-if="column === '走向核对'" :class="['match-badge', strikeMatch(row) ? 'ok' : 'bad']">
              {{ strikeMatch(row) ? '一致' : '不一致' }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="item in actionsFor(row)"
              :key="item.action"
              class="link"
              type="button"
              @click="runAction(item.action, row)"
            >
              {{ item.label }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">只读 / 已复核</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无裂缝观测数据，可先登记裂缝观测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝观测记录；宽度单位 mm，须保留两位小数</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="modalMode" class="modal-mask" @click.self="closeModal">
      <form class="modal-panel" @submit.prevent="submitModal">
        <header class="modal-head">
          <h3>{{ modalTitle }}</h3>
          <button class="link" type="button" @click="closeModal">关闭</button>
        </header>

        <p v-if="activeHazard" class="owner-tip">
          归属：{{ form.hazardNo }} · {{ activeHazard['责任片区'] }} · 责任观测人 {{ activeHazard['责任观测人'] }}
        </p>

        <template v-if="modalMode !== 'review'">
          <label v-if="modalMode === 'create'" class="form-item">
            <span>裂缝编号</span>
            <input v-model="form.crackNo" placeholder="如 CRAC-0005" required />
          </label>
          <label class="form-item">
            <span>所属隐患点</span>
            <select v-model="form.hazardNo" :disabled="modalMode !== 'create'" required @change="prefillStrike">
              <option value="" disabled>请选择隐患点</option>
              <option v-for="hazard in hazards" :key="String(hazard.id)" :value="String(hazard['隐患编号'])">
                {{ hazard['隐患编号'] }} · {{ hazard['责任片区'] }} · {{ hazard['责任观测人'] }}
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>裂缝走向</span>
            <input v-model="form.strike" placeholder="须与隐患点档案一致" required />
            <small v-if="activeHazard">档案记录：{{ activeHazard['档案裂缝走向'] }}（冲突时档案优先）</small>
          </label>
          <label class="form-item">
            <span>本期宽度（mm，两位小数）</span>
            <input v-model="form.currentWidth" inputmode="decimal" placeholder="如 3.20" required />
          </label>
          <label class="form-item">
            <span>观测日期</span>
            <input v-model="form.observationDate" type="date" required />
          </label>
        </template>

        <template v-else>
          <label class="form-item">
            <span>复核结论</span>
            <select v-model="review.conclusion" required>
              <option value="建议核销">建议核销：写入隐患点建档待办并生成待核销项</option>
              <option value="继续观测">继续观测：不生成待核销项</option>
            </select>
          </label>
          <label class="form-item">
            <span>复核日期</span>
            <input v-model="review.reviewDate" type="date" required />
          </label>
        </template>

        <p v-if="modalError" class="error-text modal-error">{{ modalError }}</p>
        <footer class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="submit">提交</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createCrackRecord,
  downloadEntries,
  listEntries,
  listHazardOptions,
  markCrackWidening,
  moduleMeta,
  reviewSealedCrack,
  sealCrack,
  submitCrackObservation,
} from '@/api/local-service'
import type { Actor, CrackFormInput, CrackReviewInput, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

type ModalMode = 'create' | 'observe' | 'widen' | 'review'

type RowAction = {
  label: string
  action: string
}

const meta = moduleMeta('crack')
const store = useSessionStore()
const columns = [
  '裂缝编号',
  '所属隐患点',
  '责任片区',
  '责任观测人',
  '裂缝走向',
  '建档裂缝走向',
  '走向核对',
  '本期宽度',
  '累计变宽',
  '观测日期',
  '观测人',
  '封填日期',
  '复核结论',
  '裂缝状态',
]
const statuses = ['待观测', '稳定', '持续变宽', '已封填']

const rows = ref<EntryRow[]>([])
const hazards = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['裂缝编号', '所属隐患点', '责任片区']
const modalMode = ref<ModalMode | null>(null)
const activeId = ref<number | null>(null)
const modalError = ref('')

const emptyForm = (): CrackFormInput => ({
  crackNo: '',
  hazardNo: '',
  strike: '',
  currentWidth: '',
  observationDate: new Date().toISOString().slice(0, 10),
})
const form = ref<CrackFormInput>(emptyForm())
const review = ref<CrackReviewInput>({ conclusion: '建议核销', reviewDate: new Date().toISOString().slice(0, 10) })

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待观测裂缝', value: rows.value.filter((row) => row.status === '待观测').length },
  { label: '持续变宽裂缝', value: rows.value.filter((row) => row.status === '持续变宽').length },
  {
    label: '累计变宽最大值(mm)',
    value: rows.value.reduce((max, row) => Math.max(max, Number(row['累计变宽']) || 0), 0).toFixed(2),
  },
])
const activeHazard = computed(() =>
  hazards.value.find((item) => String(item['隐患编号']) === form.value.hazardNo),
)
const modalTitle = computed(() => {
  switch (modalMode.value) {
    case 'create':
      return '登记裂缝观测记录'
    case 'observe':
      return '提交观测'
    case 'widen':
      return '标记持续变宽'
    case 'review':
      return '封填复核'
    default:
      return ''
  }
})
const actor = computed<Actor>(() => ({ name: store.operator, area: store.area }))

function hazardOf(row: EntryRow): EntryRow | undefined {
  return hazards.value.find((item) => String(item['隐患编号']) === String(row['所属隐患点']))
}

function strikeMatch(row: EntryRow): boolean {
  const hazard = hazardOf(row)
  if (!hazard) return false
  return String(row['裂缝走向']).replace(/\s/g, '').toUpperCase()
    === String(hazard['档案裂缝走向']).replace(/\s/g, '').toUpperCase()
}

function displayValue(row: EntryRow, column: string): string {
  if (column === '建档裂缝走向') return String(hazardOf(row)?.['档案裂缝走向'] ?? '未找到档案')
  if (column === '走向核对') return ''
  return String(row[column] ?? '—')
}

function actionsFor(row: EntryRow): RowAction[] {
  if (String(row['复核结论']).trim()) return []
  switch (row.status) {
    case '待观测':
      return [{ label: '提交观测', action: '提交观测' }]
    case '稳定':
      return [{ label: '标记变宽', action: '标记变宽' }]
    case '持续变宽':
      return [{ label: '登记封填', action: '登记封填' }]
    case '已封填':
      return [{ label: '封填复核', action: '封填复核' }]
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function fillFormFromRow(row: EntryRow) {
  form.value = {
    crackNo: String(row['裂缝编号'] ?? ''),
    hazardNo: String(row['所属隐患点'] ?? ''),
    strike: String(row['裂缝走向'] ?? ''),
    currentWidth: String(row['本期宽度'] ?? ''),
    observationDate: new Date().toISOString().slice(0, 10),
  }
}

function prefillStrike() {
  if (modalMode.value === 'create' && activeHazard.value) {
    form.value.strike = String(activeHazard.value['档案裂缝走向'])
  }
}

function openCreate() {
  modalError.value = ''
  activeId.value = null
  form.value = emptyForm()
  modalMode.value = 'create'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '登记封填') {
    const result = sealCrack(Number(row.id), actor.value)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    errorMessage.value = result.message
    reload()
    return
  }

  if (action === '封填复核') {
    modalError.value = ''
    activeId.value = Number(row.id)
    review.value = { conclusion: '建议核销', reviewDate: new Date().toISOString().slice(0, 10) }
    modalMode.value = 'review'
    return
  }

  modalError.value = ''
  activeId.value = Number(row.id)
  fillFormFromRow(row)
  modalMode.value = action === '提交观测' ? 'observe' : 'widen'
}

function closeModal() {
  modalMode.value = null
  activeId.value = null
  modalError.value = ''
}

function submitModal() {
  modalError.value = ''
  if (!modalMode.value) return
  const result = modalMode.value === 'review'
    ? reviewSealedCrack(Number(activeId.value), review.value, actor.value)
    : modalMode.value === 'create'
      ? createCrackRecord(form.value, actor.value)
      : modalMode.value === 'observe'
        ? submitCrackObservation(Number(activeId.value), form.value, actor.value)
        : markCrackWidening(Number(activeId.value), form.value, actor.value)

  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeModal()
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    hazards.value = listHazardOptions()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝观测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.crack-table {
  font-size: 12px;
}
.lock-note {
  background: #e8f1ff;
  color: #1f4e79;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.match-badge {
  margin-left: 4px;
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 11px;
}
.match-badge.ok {
  background: #e7f8ec;
  color: #177245;
}
.match-badge.bad {
  background: #fdecec;
  color: #b42318;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgb(15 23 42 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-panel {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 18px;
}
.modal-head,
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.modal-head h3 {
  margin: 0;
}
.owner-tip {
  margin: 12px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
  font-size: 13px;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
}
.form-item input,
.form-item select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
}
.form-item small {
  color: var(--muted);
}
.modal-error {
  margin: 4px 0 10px;
}
</style>
