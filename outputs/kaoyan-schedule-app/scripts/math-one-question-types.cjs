'use strict';

const MATH_ONE_QUESTION_TYPES = Object.freeze({
  高等数学: Object.freeze({
    '函数、极限与连续': Object.freeze([
      '函数性质与复合关系', '数列极限与递推极限', '等价无穷小与极限计算', '洛必达与泰勒展开',
      '夹逼准则与单调有界', '分段函数连续性参数', '间断点类型判定',
    ]),
    '一元函数微分学': Object.freeze([
      '导数定义型极限', '隐函数与参数方程求导', '高阶导数与莱布尼茨公式', '切线法线与变化率',
      '单调区间与极值判定', '凹凸拐点与渐近线', '函数最值与不等式证明',
    ]),
    '微分中值定理': Object.freeze([
      '罗尔定理辅助函数构造', '拉格朗日中值定理应用', '柯西中值定理比值构造',
      '双中值点与区间存在性', '方程根的存在性与个数', '导函数零点与原函数性质',
    ]),
    '一元函数积分学': Object.freeze([
      '换元积分与分部积分', '分段绝对值积分', '定积分对称性与周期性', '积分中值定理',
      '定积分等式与不等式证明', '变上限积分函数', '反常积分敛散性',
    ]),
    '多元函数微分学': Object.freeze([
      '偏导数与全微分判定', '多元复合函数求导', '多元隐函数求导', '方向导数与梯度',
      '无条件极值判定', '拉格朗日乘子条件极值', '多元最值应用',
    ]),
    '多元函数积分学': Object.freeze([
      '二重积分区域换序', '二重积分极坐标法', '重积分对称性', '重积分变量替换',
      '三重积分柱坐标与球坐标', '曲线积分参数化', '格林公式与路径无关',
      '曲面积分参数化', '高斯公式与通量', '斯托克斯公式与环流',
    ]),
    '无穷级数': Object.freeze([
      '正项级数审敛', '交错级数与绝对条件收敛', '幂级数收敛域', '幂级数和函数',
      '函数展开为幂级数', '傅里叶级数展开',
    ]),
    '常微分方程': Object.freeze([
      '可分离变量与齐次方程', '一阶线性与伯努利方程', '全微分方程', '可降阶高阶方程',
      '常系数线性微分方程', '欧拉方程', '微分方程应用建模',
    ]),
  }),
  线性代数: Object.freeze({
    '行列式与矩阵': Object.freeze([
      '行列式展开与递推计算', '抽象矩阵多项式运算', '分块矩阵运算', '逆矩阵与伴随矩阵',
      '矩阵秩与初等变换', '矩阵方程求解',
    ]),
    '向量与线性方程组': Object.freeze([
      '向量组线性相关性', '极大无关组与秩', '线性表示与过渡矩阵', '齐次方程组基础解系',
      '非齐次方程组解结构', '含参数方程组讨论', '公共解与同解方程组',
    ]),
    '特征值与相似': Object.freeze([
      '特征值特征向量计算', '由特征信息反求参数', '矩阵相似判定', '矩阵可对角化判定',
      '实对称矩阵正交对角化', '矩阵幂与递推关系',
    ]),
    '二次型': Object.freeze([
      '二次型矩阵表示', '合同变换与标准形', '正交变换化标准形', '正定二次型判定',
      '二次型参数范围',
    ]),
  }),
  概率论: Object.freeze({
    '随机事件与概率': Object.freeze([
      '古典概型与排列组合', '几何概型', '条件概率与乘法公式', '全概率与贝叶斯公式',
      '事件独立性判定',
    ]),
    '随机变量及其分布': Object.freeze([
      '分布函数与概率密度', '离散分布律与参数', '常见分布综合应用', '随机变量函数的分布',
      '最大最小值的分布',
    ]),
    '多维随机变量': Object.freeze([
      '联合分布与边缘分布', '条件分布', '随机变量独立性', '卷积公式求和的分布',
      '区域变换求联合分布',
    ]),
    '数字特征与极限定理': Object.freeze([
      '数学期望与方差计算', '协方差与相关系数', '条件期望', '切比雪夫不等式',
      '大数定律', '中心极限定理近似',
    ]),
    '数理统计': Object.freeze([
      '样本统计量分布', '三大抽样分布', '矩估计', '最大似然估计', '估计量评价',
    ]),
  }),
});

const GENERIC_TYPES = new Set([
  '', '选择题', '填空题', '计算题', '证明题', '综合题', '应用题', '函数题', '极限题',
  '导数题', '积分题', '线代题', '概率题', '知识题', '错题',
]);

const INFERENCE_RULES = Object.freeze([
  [/罗尔|辅助函数.*零点/, '高等数学', '罗尔定理辅助函数构造'],
  [/拉格朗日中值|中值定理.*差值/, '高等数学', '拉格朗日中值定理应用'],
  [/柯西中值|比值.*中值/, '高等数学', '柯西中值定理比值构造'],
  [/洛必达|l['’]?hopital/i, '高等数学', '洛必达与泰勒展开'],
  [/泰勒|麦克劳林/, '高等数学', '洛必达与泰勒展开'],
  [/等价无穷小/, '高等数学', '等价无穷小与极限计算'],
  [/间断点/, '高等数学', '间断点类型判定'],
  [/变上限积分|积分上限函数/, '高等数学', '变上限积分函数'],
  [/反常积分|广义积分/, '高等数学', '反常积分敛散性'],
  [/格林公式|路径无关/, '高等数学', '格林公式与路径无关'],
  [/高斯公式|通量/, '高等数学', '高斯公式与通量'],
  [/斯托克斯|环流/, '高等数学', '斯托克斯公式与环流'],
  [/拉格朗日乘子|条件极值/, '高等数学', '拉格朗日乘子条件极值'],
  [/幂级数.*收敛|收敛半径/, '高等数学', '幂级数收敛域'],
  [/傅里叶/, '高等数学', '傅里叶级数展开'],
  [/伯努利方程/, '高等数学', '一阶线性与伯努利方程'],
  [/基础解系/, '线性代数', '齐次方程组基础解系'],
  [/非齐次.*解|通解.*特解/, '线性代数', '非齐次方程组解结构'],
  [/参数.*方程组|方程组.*参数/, '线性代数', '含参数方程组讨论'],
  [/特征值.*参数|参数.*特征值/, '线性代数', '由特征信息反求参数'],
  [/可对角化/, '线性代数', '矩阵可对角化判定'],
  [/正定|正惯性指数/, '线性代数', '正定二次型判定'],
  [/贝叶斯|全概率/, '概率论', '全概率与贝叶斯公式'],
  [/联合分布|联合密度/, '概率论', '联合分布与边缘分布'],
  [/条件分布|条件密度/, '概率论', '条件分布'],
  [/协方差|相关系数/, '概率论', '协方差与相关系数'],
  [/中心极限定理|正态近似/, '概率论', '中心极限定理近似'],
  [/最大似然/, '概率论', '最大似然估计'],
  [/矩估计/, '概率论', '矩估计'],
]);

function allQuestionTypes() {
  return Object.fromEntries(Object.entries(MATH_ONE_QUESTION_TYPES).map(([subject, categories]) => [
    subject,
    Object.values(categories).flat(),
  ]));
}

function mathOneQuestionTypePrompt() {
  return Object.entries(MATH_ONE_QUESTION_TYPES).map(([subject, categories]) => (
    `${subject}：${Object.entries(categories).map(([category, types]) => `${category}[${types.join('、')}]`).join('；')}`
  )).join('\n');
}

function normalizeMathOneQuestionType(subject, rawType, context = '') {
  const normalizedSubject = String(subject || '').trim();
  const raw = String(rawType || '').trim();
  const subjectTypes = allQuestionTypes()[normalizedSubject] || [];
  if (subjectTypes.includes(raw)) return raw;
  if (raw && !GENERIC_TYPES.has(raw)) return raw;
  const evidence = `${raw} ${context}`.normalize('NFKC');
  for (const [pattern, expectedSubject, canonical] of INFERENCE_RULES) {
    if (expectedSubject === normalizedSubject && pattern.test(evidence)) return canonical;
  }
  return raw || null;
}

function mathOneQuestionTypePath(subject, rawType, context = '') {
  const normalizedSubject = String(subject || '').trim();
  const canonical = normalizeMathOneQuestionType(normalizedSubject, rawType, context);
  if (!canonical) return [];
  const categories = MATH_ONE_QUESTION_TYPES[normalizedSubject] || {};
  const category = Object.entries(categories).find(([, types]) => types.includes(canonical))?.[0];
  return category ? [category, canonical] : [canonical];
}

module.exports = {
  MATH_ONE_QUESTION_TYPES,
  allQuestionTypes,
  mathOneQuestionTypePrompt,
  mathOneQuestionTypePath,
  normalizeMathOneQuestionType,
};
