import { request } from './request'
import type { UsageFeatureRow } from '../api'

export const usageApi = {
  usageFeatures: () =>
    request<{ features: UsageFeatureRow[]; page_opens?: Record<string, number> }>(
      '/api/usage/features'
    ),
}
