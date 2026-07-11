export type AppDistribution = 'installer' | 'green'

export interface UpdateDistributionInfo {
  distribution: AppDistribution
  supportsAutoInstall: boolean
  releaseUrl: string
}

export const OPEN_COWORK_RELEASES_LATEST_URL =
  'https://github.com/AIDotNet/OpenCowork/releases/latest'
