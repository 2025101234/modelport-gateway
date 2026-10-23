/**
 * 模型可见性相关文案。
 *
 * 这里曾经还有两个键：`hideFree`（整组隐藏匿名与 Kilo 免费车道）与 `groupHidden`
 * （提示先关掉整组隐藏）。整组隐藏是随免费车道一起来的开关，车道移除后它也随之
 * 消失，所以两个键都去掉了——保留它们只会让界面显示一个不存在的状态。
 */
export function visibilityCopy(locale) {
  return String(locale).toLowerCase().startsWith('en') ? {
    hide: 'Hide model',
    show: 'Show model',
    hidden: 'Hidden by preference',
    saved: 'Model visibility saved',
  } : {
    hide: '隐藏模型',
    show: '显示模型',
    hidden: '已按偏好隐藏',
    saved: '模型显示设置已保存',
  }
}