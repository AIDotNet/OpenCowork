import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  OPEN_COWORK_RELEASES_LATEST_URL,
  type AppDistribution,
  type UpdateDistributionInfo
} from '../shared/app-distribution'

const GREEN_DISTRIBUTION_METADATA = 'green'

let cachedDistribution: AppDistribution | null = null

function readDistributionMarker(): AppDistribution {
  if (!app.isPackaged) {
    return 'installer'
  }

  const packageJsonPath = join(app.getAppPath(), 'package.json')
  if (!existsSync(packageJsonPath)) {
    return 'installer'
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      opencoworkDistribution?: unknown
    }
    return parsed.opencoworkDistribution === GREEN_DISTRIBUTION_METADATA ? 'green' : 'installer'
  } catch (error) {
    console.warn('[Distribution] Failed to read packaged app metadata:', error)
    return 'installer'
  }
}

export function getAppDistribution(): AppDistribution {
  if (!cachedDistribution) {
    cachedDistribution = readDistributionMarker()
  }

  return cachedDistribution
}

export function getUpdateDistributionInfo(): UpdateDistributionInfo {
  const distribution = getAppDistribution()

  return {
    distribution,
    supportsAutoInstall: distribution !== 'green',
    releaseUrl: OPEN_COWORK_RELEASES_LATEST_URL
  }
}

export function isAutoInstallUpdateSupported(): boolean {
  return getUpdateDistributionInfo().supportsAutoInstall
}
