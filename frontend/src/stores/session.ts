import { defineStore } from 'pinia'

// 可切换的观测人身份：裂缝归属收口按「片区 + 责任观测人」双重判定，
// 切到别的片区账号就能演示跨片区提交被退回。
export type OperatorIdentity = {
  name: string
  area: string
}

export const OPERATORS: OperatorIdentity[] = [
  { name: '李观山', area: '东片区' },
  { name: '王岭生', area: '西片区' },
  { name: '赵守坡', area: '南片区' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: OPERATORS[0].name,
    area: OPERATORS[0].area,
    shiftLabel: '白班 08:00-20:00',
    scope: '山地地质灾害隐患巡查与治理工作台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(name: string) {
      const target = OPERATORS.find((item) => item.name === name)
      if (target) {
        this.operator = target.name
        this.area = target.area
      }
    },
  },
})
