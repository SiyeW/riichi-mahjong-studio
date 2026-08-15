const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const REPORT_PATH_PATTERN = /^\/report\/([A-Za-z0-9_-]{8,128})\.json$/
const { translate } = require('./i18n')

function normalizeMortalReportUrl(rawInput, localize = (key) => translate('zh-CN', key)) {
  const input = String(rawInput || '').trim()
  if (!input) {
    throw new Error(localize('native.mortal.empty'))
  }

  let reportId = ''
  if (REPORT_ID_PATTERN.test(input)) {
    reportId = input
  } else {
    let parsed
    try {
      parsed = new URL(input)
    } catch {
      throw new Error(localize('native.mortal.invalidUrl'))
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mjai.ekyu.moe') {
      throw new Error(localize('native.mortal.unsupportedHost'))
    }

    if (/^\/progress\/?$/.test(parsed.pathname)) {
      const taskId = parsed.searchParams.get('task') || ''
      if (REPORT_ID_PATTERN.test(taskId)) reportId = taskId
    } else {
      const dataPath = parsed.searchParams.get('data') || ''
      const targetPath = dataPath || parsed.pathname
      const match = targetPath.match(REPORT_PATH_PATTERN)
      if (match) reportId = match[1]
    }
  }

  if (!reportId) {
    throw new Error(localize('native.mortal.noId'))
  }
  return `https://mjai.ekyu.moe/report/${reportId}.json`
}

module.exports = { normalizeMortalReportUrl }
