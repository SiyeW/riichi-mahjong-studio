const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const REPORT_PATH_PATTERN = /^\/report\/([A-Za-z0-9_-]{8,128})\.json$/

function normalizeMortalReportUrl(rawInput) {
  const input = String(rawInput || '').trim()
  if (!input) {
    throw new Error('请粘贴 Mortal 在线牌谱网址。')
  }

  let reportId = ''
  if (REPORT_ID_PATTERN.test(input)) {
    reportId = input
  } else {
    let parsed
    try {
      parsed = new URL(input)
    } catch {
      throw new Error('网址格式不正确。')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mjai.ekyu.moe') {
      throw new Error('目前只支持 mjai.ekyu.moe 的公开 Mortal 报告。')
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
    throw new Error('未能从网址中识别 Mortal 报告 ID。')
  }
  return `https://mjai.ekyu.moe/report/${reportId}.json`
}

module.exports = { normalizeMortalReportUrl }
