// assets/charts.js — 验收报告图表（ECharts，颜色取自 CSS 变量）
(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- 图 2：协议增强前后偏移错误次数 ---
  var el = document.getElementById('chart-anchor');
  if (!el || typeof echarts === 'undefined') return;
  var chart = echarts.init(el, null, { renderer: 'svg' });
  chart.setOption({
    animation: false,
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      formatter: function (p) {
        var d = p[0];
        return d.name + '<br/>偏移错误：<b>' + d.value + '</b> 次';
      }
    },
    grid: { left: 60, right: 30, top: 40, bottom: 40 },
    xAxis: {
      type: 'category',
      data: ['协议 v1 纯偏移\n（4 次真实调用）', '协议 v1 + oldText 锚点\n（2 次真实调用）'],
      axisLabel: { color: muted, fontSize: 13, lineHeight: 18 },
      axisLine: { lineStyle: { color: rule } }
    },
    yAxis: {
      type: 'value',
      name: '错误次数',
      nameTextStyle: { color: muted },
      minInterval: 1,
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'bar',
      barWidth: 96,
      data: [
        { value: 4, itemStyle: { color: accent } },
        { value: 0, itemStyle: { color: accent2 } }
      ],
      label: {
        show: true,
        position: 'top',
        color: ink,
        fontWeight: 700,
        formatter: function (p) { return p.value + ' 次'; }
      }
    }]
  });
  window.addEventListener('resize', function () { chart.resize(); });
})();
