import { defineStore } from 'pinia'

export type SessionIdentity = {
  name: string
  area: string
}

export const IDENTITIES: SessionIdentity[] = [
  { name: '王观测', area: '北片区' },
  { name: '李观测', area: '南片区' },
  { name: '赵观测', area: '东片区' },
  { name: '周巡查', area: '北片区' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: IDENTITIES[0].name,
    area: IDENTITIES[0].area,
    shiftLabel: '白班 08:00-20:00',
    scope: '山地地质灾害隐患巡查与治理工作台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    identity: (state): SessionIdentity => ({ name: state.operator, area: state.area }),
  },
  actions: {
    setIdentity(identity: SessionIdentity) {
      this.operator = identity.name
      this.area = identity.area
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
