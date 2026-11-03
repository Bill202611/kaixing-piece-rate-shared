// =====================================================================
// 计件单价计算核心模块（与原 H5 / 小程序公式完全一致）
// 公式：
//   标准工时(秒/把) = 作业时间 × (1 + 宽放率) × 效率系数
//   计件单价(元/把) = 标准工时 ÷ 3600 × 时薪
//   装网袋单价(元/把) = 装网袋时间 × (1 + 宽放率) × 效率系数 ÷ 3600 × 时薪
//   合计单价(元/把) = 计件单价 + 装网袋单价
//   总工资 = 合计单价 × 件数
// UMD 兼容浏览器全局变量 window.KxCalc 与 Node require
// =====================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KxCalc = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round(num, places) {
    if (!isFinite(num)) return 0;
    var p = Math.pow(10, places);
    return Math.round(num * p) / p;
  }

  function calcProcess(p, opts) {
    opts = opts || {};
    var efficiency = (typeof opts.efficiency === 'number' && isFinite(opts.efficiency)) ? opts.efficiency : 1;
    var places = (typeof opts.decimalPlaces === 'number') ? opts.decimalPlaces : 4;

    var operationTime = Number(p.operationTime) || 0;
    var allowanceRate = Number(p.allowanceRate) || 0;
    var hourlyWage = Number(p.hourlyWage) || 0;
    var netBagTime = Number(p.netBagTime) || 0;

    var standardTime = operationTime * (1 + allowanceRate) * efficiency;
    var piecePrice = standardTime / 3600 * hourlyWage;
    var netBagStandardTime = netBagTime > 0 ? netBagTime * (1 + allowanceRate) * efficiency : 0;
    var netBagPrice = netBagStandardTime / 3600 * hourlyWage;
    var totalPrice = piecePrice + netBagPrice;

    return {
      standardTime: round(standardTime, places),
      piecePrice: round(piecePrice, places),
      netBagStandardTime: round(netBagStandardTime, places),
      netBagPrice: round(netBagPrice, places),
      totalPrice: round(totalPrice, places),
      formulaParts: {
        standardTime: operationTime + ' × (1+' + allowanceRate + ') × ' + efficiency + ' = ' + round(standardTime, places),
        piecePrice: round(standardTime, places) + ' ÷ 3600 × ' + hourlyWage + ' = ' + round(piecePrice, places),
        netBagPrice: netBagTime > 0
          ? netBagTime + ' × (1+' + allowanceRate + ') × ' + efficiency + ' ÷ 3600 × ' + hourlyWage + ' = ' + round(netBagPrice, places)
          : '无装网袋作业，计 0',
        totalPrice: round(piecePrice, places) + ' + ' + round(netBagPrice, places) + ' = ' + round(totalPrice, places)
      }
    };
  }

  function calcTotal(processes, opts) {
    opts = opts || {};
    var places = (typeof opts.decimalPlaces === 'number') ? opts.decimalPlaces : 4;
    var sum = 0;
    var details = processes.map(function (p) {
      var r = calcProcess(p, opts);
      sum += r.totalPrice;
      return {
        id: p.id, code: p.code, name: p.name, category: p.category,
        totalPrice: r.totalPrice, piecePrice: r.piecePrice, netBagPrice: r.netBagPrice
      };
    });
    return { totalPrice: round(sum, places), details: details };
  }

  function batchAdjustPrice(processes, percent) {
    var factor = 1 + (Number(percent) || 0) / 100;
    return processes.map(function (p) {
      var o = {};
      for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k]; }
      o.hourlyWage = round((Number(p.hourlyWage) || 0) * factor, 4);
      return o;
    });
  }

  function calcWages(totalPricePerPiece, quantity) {
    return round((Number(totalPricePerPiece) || 0) * (Number(quantity) || 0), 2);
  }

  return {
    round: round,
    calcProcess: calcProcess,
    calcTotal: calcTotal,
    batchAdjustPrice: batchAdjustPrice,
    calcWages: calcWages
  };
}));
