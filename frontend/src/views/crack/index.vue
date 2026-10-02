<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝观测管理</h2>
        <p class="page-desc">
          裂缝编号落到哪个隐患点，就归那个隐患点的责任观测人维护；封填后转为只读，跨片区提交一律退回并注明原因。
          状态按 待观测 → 稳定 → 持续变宽 → 已封填 逐环流转，越级挡下；本期宽度只认到 0.1mm。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝观测清单</button>
      </div>
    </header>

    <p class="context-line">
      当前身份：<strong>{{ store.operator }}</strong>（{{ store.area }}）——只能维护本片区、且本人为责任观测人的裂缝；其他片区记录只读。
    </p>

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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="String(row.status) === '已封填'" class="tag tag-readonly">封填只读</span>
            <span v-if="reviewedCodes.has(String(row['裂缝编号']))" class="tag tag-reviewed">已复核</span>
          </td>
          <td class="row-actions">
            <template v-if="ownerOf(row)">
              <button
                v-for="action in nextActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runFlow(action, row)"
              >
                {{ action }}
              </button>
              <button
                v-if="String(row.status) !== '已封填'"
                class="link"
                type="button"
                @click="openEdit(row)"
              >
                修改本期观测
              </button>
              <button
                v-if="String(row.status) === '已封填' && !reviewedCodes.has(String(row['裂缝编号']))"
                class="link"
                type="button"
                @click="openReview(row)"
              >
                提交复核
              </button>
              <span v-if="!hasAnyAction(row)" class="muted-text">无可执行动作</span>
            </template>
            <span v-else class="muted-text">归属 {{ ownerLabel(row) }}，跨片区只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无裂缝观测数据，可先登记裂缝观测记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 登记裂缝 -->
    <div v-if="createVisible" class="modal-mask" @click.self="closeDialogs">
      <form class="modal" @submit.prevent="submitCreate">
        <h3>登记裂缝观测记录</h3>
        <label class="form-item">
          <span>归属隐患点</span>
          <select v-model="createForm.所属隐患点" required>
            <option value="" disabled>请选择已建档隐患点（限本片区责任）</option>
            <option v-for="hazard in myHazards" :key="String(hazard.id)" :value="String(hazard['隐患编号'])">
              {{ hazard['隐患编号'] }}｜{{ hazard['所在乡镇'] }}｜责任人 {{ hazard['责任观测人'] }}
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>裂缝走向</span>
          <input v-model="createForm.裂缝走向" placeholder="如：北东35°" required />
        </label>
        <label class="form-item">
          <span>本期宽度（mm，精度 0.1）</span>
          <input v-model="createForm.本期宽度" inputmode="decimal" placeholder="如：3.2" required />
        </label>
        <label class="form-item">
          <span>观测日期</span>
          <input v-model="createForm.观测日期" type="date" required />
        </label>
        <p class="form-hint">裂缝编号自动生成，登记后状态为「待观测」，归属即锁到该隐患点责任观测人。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </div>
      </form>
    </div>

    <!-- 修改本期观测 -->
    <div v-if="editTarget" class="modal-mask" @click.self="closeDialogs">
      <form class="modal" @submit.prevent="submitEdit">
        <h3>修改本期观测 · {{ editTarget['裂缝编号'] }}</h3>
        <p class="form-hint">
          归属隐患点 {{ editTarget['所属隐患点'] }}，责任观测人 {{ editTarget['观测人'] }}。
          封填后本窗口不可再用；本期宽度超过 0.1mm 精度将直接退回、不落库。
        </p>
        <label class="form-item">
          <span>裂缝走向</span>
          <input v-model="editForm.裂缝走向" required />
        </label>
        <label class="form-item">
          <span>本期宽度（mm，精度 0.1）</span>
          <input v-model="editForm.本期宽度" inputmode="decimal" required />
        </label>
        <label class="form-item">
          <span>观测日期</span>
          <input v-model="editForm.观测日期" type="date" required />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="submit">保存观测</button>
        </div>
      </form>
    </div>

    <!-- 封填复核 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="closeDialogs">
      <form class="modal" @submit.prevent="submitReview">
        <h3>封填复核 · {{ reviewTarget['裂缝编号'] }}</h3>
        <p class="form-hint">
          复核走向会与裂缝档案走向两处核对；冲突按优先级（已封填裂缝档案＞本期观测记录＞复核填报）以档案为准。
          受理后在隐患核销清单生成该隐患点的待核销项，重复复核只保留最早一份。
        </p>
        <label class="form-item">
          <span>复核走向（档案：{{ reviewTarget['裂缝走向'] }}）</span>
          <input v-model="reviewForm.复核走向" required />
        </label>
        <label class="form-item">
          <span>复核结论</span>
          <textarea v-model="reviewForm.复核结论" rows="3" placeholder="如：封填密实，周边未见新增变形，建议核销" required></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="submit">提交复核结论</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝观测记录</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  registerCrack,
  saveObservation,
  submitCrackReview,
  findHazard,
  hazards,
  type Identity,
} from '@/api/crack-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('crack')
const columns = ['裂缝编号', '所属隐患点', '所属片区', '裂缝走向', '本期宽度', '累计变宽', '观测日期', '观测人', '裂缝状态']
const statuses = ['待观测', '稳定', '持续变宽', '已封填']
const FLOW_ORDER = ['提交观测', '标记变宽', '登记封填']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['裂缝编号', '所属隐患点', '所属片区']

const identity = computed<Identity>(() => ({ 观测人: store.operator, 片区: store.area }))
const myHazards = computed(() =>
  hazards().filter(
    (row) =>
      String(row['责任片区']) === store.area &&
      String(row['责任观测人']) === store.operator,
  ),
)
const reviewedCodes = computed(() => {
  const codes = new Set<string>()
  for (const row of listEntries('clearance').items) {
    const code = String(row['来源裂缝编号'] ?? '').trim()
    if (code) {
      codes.add(code)
    }
  }
  return codes
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const toNumber = (value: unknown) => Number(value) || 0
  return [
    { label: '待观测裂缝', value: rows.value.filter((row) => String(row.status) === '待观测').length },
    { label: '持续变宽裂缝', value: rows.value.filter((row) => String(row.status) === '持续变宽').length },
    {
      label: '累计变宽最大值(mm)',
      value: rows.value.reduce((max, row) => Math.max(max, toNumber(row['累计变宽'])), 0),
    },
  ]
})

function ownerOf(row: EntryRow): boolean {
  // 归属以隐患点档案上的责任片区/责任观测人为准，不以裂缝行冗余字段为准。
  const hazard = findHazard(String(row['所属隐患点'] ?? ''))
  return Boolean(
    hazard &&
      String(hazard['责任片区']) === store.area &&
      String(hazard['责任观测人']) === store.operator,
  )
}

function ownerLabel(row: EntryRow): string {
  const hazard = findHazard(String(row['所属隐患点'] ?? ''))
  return hazard
    ? `${String(hazard['责任片区'])} / ${String(hazard['责任观测人'])}`
    : '隐患点档案缺失'
}

function nextActions(row: EntryRow): string[] {
  const index = statuses.indexOf(String(row.status))
  // 只露出「下一环」动作；越级动作不给入口，服务层还会再挡一道。
  return index >= 0 && index < FLOW_ORDER.length ? [FLOW_ORDER[index]] : []
}

function hasAnyAction(row: EntryRow): boolean {
  if (nextActions(row).length > 0) {
    return true
  }
  if (String(row.status) !== '已封填') {
    return true
  }
  return !reviewedCodes.value.has(String(row['裂缝编号']))
}

function flash(ok: boolean, message: string, reloadAfter = true) {
  successMessage.value = ok ? message : ''
  errorMessage.value = ok ? '' : message
  if (reloadAfter) {
    reload()
  }
}

function runFlow(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action, identity.value)
  flash(result.ok, result.message)
}

// ---- 登记 ----
const createVisible = ref(false)
const createForm = reactive({ 所属隐患点: '', 裂缝走向: '', 本期宽度: '', 观测日期: '' })

function openCreate() {
  Object.assign(createForm, {
    所属隐患点: '',
    裂缝走向: '',
    本期宽度: '',
    观测日期: new Date().toISOString().slice(0, 10),
  })
  successMessage.value = ''
  errorMessage.value = ''
  createVisible.value = true
}

function submitCreate() {
  const result = registerCrack({ ...createForm }, identity.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeDialogs()
  flash(true, result.message)
}

// ---- 修改本期观测 ----
const editTarget = ref<EntryRow | null>(null)
const editForm = reactive({ 裂缝走向: '', 本期宽度: '', 观测日期: '' })

function openEdit(row: EntryRow) {
  Object.assign(editForm, {
    裂缝走向: String(row['裂缝走向'] ?? ''),
    本期宽度: String(row['本期宽度'] ?? ''),
    观测日期: String(row['观测日期'] ?? ''),
  })
  successMessage.value = ''
  errorMessage.value = ''
  editTarget.value = row
}

function submitEdit() {
  if (!editTarget.value) {
    return
  }
  const result = saveObservation(Number(editTarget.value.id), { ...editForm }, identity.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeDialogs()
  flash(true, result.message)
}

// ---- 封填复核 ----
const reviewTarget = ref<EntryRow | null>(null)
const reviewForm = reactive({ 复核走向: '', 复核结论: '' })

function openReview(row: EntryRow) {
  Object.assign(reviewForm, { 复核走向: String(row['裂缝走向'] ?? ''), 复核结论: '' })
  successMessage.value = ''
  errorMessage.value = ''
  reviewTarget.value = row
}

function submitReview() {
  if (!reviewTarget.value) {
    return
  }
  const result = submitCrackReview(Number(reviewTarget.value.id), { ...reviewForm }, identity.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeDialogs()
  flash(true, result.message)
}

function closeDialogs() {
  createVisible.value = false
  editTarget.value = null
  reviewTarget.value = null
  errorMessage.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝观测列表读取失败'
  }
}

store.$subscribe(() => {
  if (!createVisible.value && !editTarget.value && !reviewTarget.value) {
    reload()
  }
})

onMounted(reload)
</script>
