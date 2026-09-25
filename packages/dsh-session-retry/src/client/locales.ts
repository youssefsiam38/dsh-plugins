/** `session-retry` namespace dictionaries. */

/** English dictionary (the key-set source of truth). */
export const en = {
  'block.aria': 'Automatic retry',
  'status.waiting': 'Retrying {attempt}/{max}',
  'status.notReady': 'waiting: {reason}',
  'status.next': 'next in {time}',
  'status.due': 'retrying now',
  'status.running': 'Retry {attempt}/{max} in progress',
  'status.exhausted': 'Gave up after {max} attempts',
  'tooltip.next': 'Next retry: {date}',
  'tooltip.reason': 'Reason: {reason}',
  'tooltip.exhausted': 'Last failure: {reason}',
  'action.retryNow': 'Retry now',
  'action.stop': 'Stop',
  'action.failed': 'The session did not accept the request',
  'time.seconds': '{n} s',
  'time.minutes': '{n} min',
  'time.hours': '{n} h',
  'time.days': '{n} d',
  'reason.builtin:provider-stall': 'the model provider stopped responding',
  'reason.builtin:transport': 'the connection to the model provider failed',
  'reason.builtin:server-error': 'the model provider returned a server error',
  'reason.builtin:rate-limit': 'the model provider rate-limited the request',
} satisfies Record<string, string>

/** Key union of the namespace. */
export type SessionRetryKey = keyof typeof en

/** Simplified Chinese dictionary, checked complete against the English key set. */
export const zh = {
  'block.aria': '自动重试',
  'status.waiting': '正在重试 {attempt}/{max}',
  'status.notReady': '等待：{reason}',
  'status.next': '{time}后重试',
  'status.due': '即将重试',
  'status.running': '第 {attempt}/{max} 次重试进行中',
  'status.exhausted': '已尝试 {max} 次，停止重试',
  'tooltip.next': '下次重试：{date}',
  'tooltip.reason': '原因：{reason}',
  'tooltip.exhausted': '最后一次失败：{reason}',
  'action.retryNow': '立即重试',
  'action.stop': '停止',
  'action.failed': '会话未接受该请求',
  'time.seconds': '{n} 秒',
  'time.minutes': '{n} 分钟',
  'time.hours': '{n} 小时',
  'time.days': '{n} 天',
  'reason.builtin:provider-stall': '模型服务停止响应',
  'reason.builtin:transport': '与模型服务的连接失败',
  'reason.builtin:server-error': '模型服务返回服务器错误',
  'reason.builtin:rate-limit': '模型服务限制了请求频率',
} satisfies Record<SessionRetryKey, string>
