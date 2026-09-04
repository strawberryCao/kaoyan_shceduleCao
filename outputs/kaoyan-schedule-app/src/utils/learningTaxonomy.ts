export type LearningClassificationPath = string[];

type ClassifiableItem = {
  questionType?: string;
  wrongReason?: string;
  intent?: { shouldMemorize?: boolean };
};

export type ClassifiableLearningNote = {
  subject?: string;
  knowledgePath?: string[];
  questionType?: string;
  questionTypePath?: string[];
  wrongReason?: string;
  wrongReasonPath?: string[];
  learningTypePath?: string[];
  goodQuestionType?: string | null;
  goodQuestion?: boolean | null;
  noteType?: string;
  title?: string;
  remark?: string;
  tags?: string[];
  items?: ClassifiableItem[];
};

const MAX_PATH_DEPTH = 3;

export const LEGACY_WRONG_REASON_PATHS: LearningClassificationPath[] = [
  ['审题理解', '条件识别', '看漏条件'],
  ['审题理解', '条件识别', '误读条件'],
  ['审题理解', '条件识别', '隐含条件未识别'],
  ['审题理解', '问题目标', '问法理解错误'],
  ['审题理解', '问题目标', '求解对象看错'],
  ['审题理解', '问题目标', '范围边界忽略'],
  ['审题理解', '信息提取', '图表读取错误'],
  ['审题理解', '信息提取', '关键词误判'],
  ['审题理解', '信息提取', '已知量关系误读'],
  ['知识掌握', '概念辨析', '定义不清'],
  ['知识掌握', '概念辨析', '概念混淆'],
  ['知识掌握', '概念辨析', '性质记错'],
  ['知识掌握', '公式定理', '公式遗忘'],
  ['知识掌握', '公式定理', '定理误用'],
  ['知识掌握', '公式定理', '适用条件不清'],
  ['知识掌握', '知识缺口', '尚未掌握'],
  ['知识掌握', '知识缺口', '记忆模糊'],
  ['知识掌握', '知识缺口', '迁移失败'],
  ['思路方法', '方法选择', '方法选错'],
  ['思路方法', '方法选择', '未识别题型'],
  ['思路方法', '方法选择', '解题路径过绕'],
  ['思路方法', '构造转化', '辅助构造失败'],
  ['思路方法', '构造转化', '等价转化错误'],
  ['思路方法', '构造转化', '分类讨论不全'],
  ['思路方法', '完整性检查', '特殊情形遗漏'],
  ['思路方法', '完整性检查', '边界反例遗漏'],
  ['思路方法', '完整性检查', '结果检验不足'],
  ['推理过程', '逻辑链条', '推理跳步'],
  ['推理过程', '逻辑链条', '依据不足'],
  ['推理过程', '逻辑链条', '因果倒置'],
  ['推理过程', '条件关系', '充分必要混淆'],
  ['推理过程', '条件关系', '条件范围扩大'],
  ['推理过程', '条件关系', '结论错误外推'],
  ['推理过程', '步骤执行', '步骤顺序错误'],
  ['推理过程', '步骤执行', '中间结论错误'],
  ['推理过程', '步骤执行', '未回代验证'],
  ['计算执行', '运算错误', '算术计算错误'],
  ['计算执行', '运算错误', '代数变形错误'],
  ['计算执行', '运算错误', '化简约分错误'],
  ['计算执行', '符号表达', '正负号错误'],
  ['计算执行', '符号表达', '括号下标错误'],
  ['计算执行', '符号表达', '单位精度错误'],
  ['计算执行', '专项计算', '求导错误'],
  ['计算执行', '专项计算', '积分错误'],
  ['计算执行', '专项计算', '矩阵变换错误'],
  ['注意力与习惯', '粗心疏漏', '看漏条件'],
  ['注意力与习惯', '粗心疏漏', '审题不仔细'],
  ['注意力与习惯', '粗心疏漏', '计算错误'],
  ['注意力与习惯', '粗心疏漏', '抄错数据'],
  ['注意力与习惯', '粗心疏漏', '漏项漏写'],
  ['注意力与习惯', '专注状态', '走神分心'],
  ['注意力与习惯', '专注状态', '思维中断'],
  ['注意力与习惯', '专注状态', '检查不到位'],
  ['注意力与习惯', '作答习惯', '跳步过快'],
  ['注意力与习惯', '作答习惯', '书写潦草'],
  ['注意力与习惯', '作答习惯', '草稿混乱'],
  ['记忆提取', '回忆失败', '公式想不起'],
  ['记忆提取', '回忆失败', '结论混淆'],
  ['记忆提取', '回忆失败', '关键词遗漏'],
  ['记忆提取', '熟练度不足', '反应过慢'],
  ['记忆提取', '熟练度不足', '步骤不熟'],
  ['记忆提取', '熟练度不足', '模板调用失败'],
  ['时间与策略', '时间分配', '单题停留过久'],
  ['时间与策略', '时间分配', '前松后紧'],
  ['时间与策略', '时间分配', '未留检查时间'],
  ['时间与策略', '考场决策', '难题纠缠'],
  ['时间与策略', '考场决策', '跳题时机不当'],
  ['时间与策略', '考场决策', '盲目修改'],
  ['其他', '信息不足', '尚未明确'],
  ['其他', '资料与工具', '资料识别错误'],
  ['其他', '资料与工具', '工具操作错误'],
];

const WRONG_REASON_ROOT_ALIASES: Record<string, string> = {
  审题理解: '粗心大意',
  审题与信息: '粗心大意',
  注意力与习惯: '粗心大意',
  知识掌握: '知识与记忆',
  记忆提取: '知识与记忆',
  思路方法: '思路与方法',
  推理过程: '推理与计算',
  推理与步骤: '推理与计算',
  计算执行: '推理与计算',
  计算与表达: '推理与计算',
};

// Only seed a compact, useful tree. New stable leaf categories are surfaced
// dynamically from actual notes instead of preloading dozens of empty choices.
export const WRONG_REASON_PATHS: LearningClassificationPath[] = [
  ['粗心大意', '审题疏漏', '看漏条件'],
  ['粗心大意', '审题疏漏', '误读条件'],
  ['粗心大意', '计算疏漏', '算术错误'],
  ['粗心大意', '计算疏漏', '正负号错误'],
  ['粗心大意', '计算疏漏', '抄错数据'],
  ['粗心大意', '注意力', '走神分心'],
  ['粗心大意', '注意力', '思维中断'],
  ['粗心大意', '作答习惯', '漏项漏写'],
  ['粗心大意', '作答习惯', '草稿混乱'],
  ['粗心大意', '作答习惯', '检查不到位'],
  ['知识与记忆', '概念辨析', '概念混淆'],
  ['知识与记忆', '公式定理', '公式遗忘'],
  ['知识与记忆', '知识缺口', '尚未掌握'],
  ['思路与方法', '方法选择', '方法选错'],
  ['思路与方法', '方法选择', '未识别题型'],
  ['思路与方法', '构造转化', '等价转化错误'],
  ['推理与计算', '逻辑推理', '推理跳步'],
  ['推理与计算', '步骤执行', '步骤顺序错误'],
  ['推理与计算', '运算错误', '代数变形错误'],
  ['时间与策略', '时间分配', '单题停留过久'],
  ['时间与策略', '考场决策', '难题纠缠'],
  ['其他', '信息不足', '尚未明确'],
];

const RAW_LEARNING_TYPE_PATHS: LearningClassificationPath[] = [
  ['纯知识', '定义概念'],
  ['纯知识', '原理机制'],
  ['纯知识', '公式定理'],
  ['纯知识', '性质条件'],
  ['纯知识', '术语辨析'],
  ['题型方法', '题型识别'],
  ['题型方法', '标准步骤'],
  ['题型方法', '方法选择'],
  ['题型方法', '构造技巧'],
  ['题型方法', '答题模板'],
  ['结论规律', '常用结论'],
  ['结论规律', '等价关系'],
  ['结论规律', '适用条件'],
  ['结论规律', '边界反例'],
  ['结论规律', '推论拓展'],
  ['易错警示', '易混概念'],
  ['易错警示', '条件遗漏'],
  ['易错警示', '符号范围'],
  ['易错警示', '特殊情形'],
  ['易错警示', '检查清单'],
  ['语言积累', '单词短语'],
  ['语言积累', '长难句'],
  ['语言积累', '翻译表达'],
  ['语言积累', '写作模板'],
  ['语言积累', '语法规则'],
  ['政治材料', '核心概念'],
  ['政治材料', '原理表述'],
  ['政治材料', '时政材料'],
  ['政治材料', '分析模板'],
  ['政治材料', '关键词句'],
];

const LEARNING_TYPE_ROOT_ALIASES: Record<string, string> = {
  纯知识: '基础知识',
  语言积累: '英语积累',
};

export const LEARNING_TYPE_PATHS: LearningClassificationPath[] = RAW_LEARNING_TYPE_PATHS.map((path) => (
  [LEARNING_TYPE_ROOT_ALIASES[path[0]] || path[0], ...path.slice(1)]
));

export const GOOD_QUESTION_TYPES = [
  '经典母题',
  '方法好题',
  '易错辨析',
  '综合提升',
  '新颖拓展',
] as const;

const MATH_QUESTION_CHAPTERS: Array<[RegExp, string]> = [
  [/函数性质|复合关系|数列极限|递推极限|无穷小|极限计算|洛必达|泰勒|夹逼|单调有界|连续性|间断点/u, '函数、极限与连续'],
  [/导数定义|隐函数|参数方程求导|高阶导数|莱布尼茨|切线|法线|变化率|单调区间|凹凸|拐点|渐近线|函数最值/u, '一元函数微分学'],
  [/罗尔|拉格朗日中值|柯西中值|中值点|区间存在性|方程根|导函数零点/u, '微分中值定理'],
  [/换元积分|分部积分|绝对值积分|定积分|积分中值|变上限|反常积分/u, '一元函数积分学'],
  [/偏导|全微分|多元复合|多元隐函数|方向导数|梯度|无条件极值|拉格朗日乘子|多元最值/u, '多元函数微分学'],
  [/二重积分|三重积分|重积分|曲线积分|曲面积分|格林公式|高斯公式|斯托克斯公式/u, '多元函数积分学'],
  [/正项级数|交错级数|绝对条件收敛|幂级数|傅里叶级数/u, '无穷级数'],
  [/可分离变量|齐次方程|伯努利方程|全微分方程|可降阶|常系数线性|欧拉方程|微分方程/u, '常微分方程'],
  [/行列式|矩阵多项式|分块矩阵|逆矩阵|伴随矩阵|矩阵秩|初等变换|矩阵方程/u, '行列式与矩阵'],
  [/向量组|极大无关组|线性表示|过渡矩阵|齐次方程组|非齐次方程组|参数方程组|公共解|同解方程组/u, '向量与线性方程组'],
  [/特征值|特征向量|矩阵相似|对角化|实对称矩阵|矩阵幂/u, '特征值与相似'],
  [/二次型|合同变换|标准形|正定/u, '二次型'],
  [/古典概型|几何概型|条件概率|全概率|贝叶斯|事件独立/u, '随机事件与概率'],
  [/分布函数|概率密度|离散分布|常见分布|随机变量函数|最大最小值/u, '随机变量及其分布'],
  [/联合分布|边缘分布|条件分布|随机变量独立|卷积公式|区域变换/u, '多维随机变量'],
  [/数学期望|方差|协方差|相关系数|条件期望|切比雪夫|大数定律|中心极限/u, '数字特征与极限定理'],
  [/样本统计量|抽样分布|矩估计|最大似然|估计量/u, '数理统计'],
];

const normalizeSegment = (value: unknown): string => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 60);

export const normalizeLearningPath = (value: unknown): LearningClassificationPath => {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s*(?:>|›|\/|→)\s*/u)
      : [];
  const output: string[] = [];
  for (const item of source) {
    const segment = normalizeSegment(item);
    if (!segment || output.includes(segment)) continue;
    output.push(segment);
    if (output.length >= MAX_PATH_DEPTH) break;
  }
  return output;
};

const taggedPath = (tags: string[] | undefined, prefix: string): LearningClassificationPath => {
  const value = (tags ?? []).find((tag) => tag.startsWith(prefix));
  return normalizeLearningPath(value?.slice(prefix.length));
};

export const classificationPathLabel = (value: unknown): string => normalizeLearningPath(value).join(' › ');

const canonicalizeRoot = (value: unknown, aliases: Record<string, string>): LearningClassificationPath => {
  const path = normalizeLearningPath(value);
  if (path.length === 0) return path;
  return [aliases[path[0]] || path[0], ...path.slice(1)];
};

export const classificationPathMatches = (value: unknown, selected: unknown): boolean => {
  const path = normalizeLearningPath(value);
  const filter = normalizeLearningPath(selected);
  return filter.length === 0 || filter.every((segment, index) => path[index] === segment);
};

export const classificationOptionsAtLevel = (
  paths: unknown[],
  selected: unknown,
  level: number,
): string[] => {
  const prefix = normalizeLearningPath(selected).slice(0, level);
  const options = new Set<string>();
  for (const value of paths) {
    const path = normalizeLearningPath(value);
    if (path.length <= level || !prefix.every((segment, index) => path[index] === segment)) continue;
    options.add(path[level]);
  }
  return [...options].sort((left, right) => left.localeCompare(right, 'zh-CN'));
};

const firstUseful = (values: Array<string | null | undefined>): string => values
  .map(normalizeSegment)
  .find(Boolean) ?? '';

export const questionTypePathForNote = (note: ClassifiableLearningNote): LearningClassificationPath => {
  const stored = normalizeLearningPath(note.questionTypePath);
  if (stored.length > 0) return stored;
  const tagged = taggedPath(note.tags, '题型路径:');
  if (tagged.length > 0) return tagged;
  const leaf = firstUseful([
    note.questionType,
    ...(note.items ?? []).map((item) => item.questionType),
  ]);
  if (!leaf) return [];
  const mathChapter = MATH_QUESTION_CHAPTERS.find(([pattern]) => pattern.test(leaf))?.[1];
  if (mathChapter) return mathChapter === leaf ? [leaf] : [mathChapter, leaf];
  const knowledgePoint = normalizeLearningPath(note.knowledgePath)
    .find((segment) => segment !== normalizeSegment(note.subject));
  return knowledgePoint && knowledgePoint !== leaf ? [knowledgePoint, leaf] : [leaf];
};

const inferWrongReasonPath = (rawValue: string): LearningClassificationPath => {
  const value = normalizeSegment(rawValue).toLowerCase();
  if (!value) return [];
  if (/走神|分心|注意力/u.test(value)) return ['粗心大意', '注意力', '走神分心'];
  if (/草稿.*乱|草稿混乱/u.test(value)) return ['粗心大意', '作答习惯', '草稿混乱'];
  if (/书写.*潦草|字迹/u.test(value)) return ['粗心大意', '作答习惯', '书写潦草'];
  if (/跳步|过快|急着/u.test(value)) return ['粗心大意', '作答习惯', '跳步过快'];
  if (/粗心/u.test(value)) {
    if (/审题|题意|条件/u.test(value)) return ['粗心大意', '审题疏漏', '审题不仔细'];
    if (/抄|数据/u.test(value)) return ['粗心大意', '计算疏漏', '抄错数据'];
    if (/计算|算错|运算/u.test(value)) return ['粗心大意', '计算疏漏', '算术错误'];
    return ['粗心大意', '作答习惯', '漏项漏写'];
  }
  if (/漏看|看漏|漏条件|遗漏条件/u.test(value)) return ['粗心大意', '审题疏漏', '看漏条件'];
  if (/审题|题意|误读条件|条件看错/u.test(value)) return ['粗心大意', '审题疏漏', '误读条件'];
  if (/范围|边界|端点|定义域/u.test(value)) return ['审题理解', '问题目标', '范围边界忽略'];
  if (/概念.*混|混淆/u.test(value)) return ['知识掌握', '概念辨析', '概念混淆'];
  if (/定义.*不清|概念.*不清/u.test(value)) return ['知识掌握', '概念辨析', '定义不清'];
  if (/公式.*忘|定理.*忘|没记住/u.test(value)) return ['知识掌握', '公式定理', '公式遗忘'];
  if (/定理.*误用|公式.*误用|法则.*误用/u.test(value)) return ['知识掌握', '公式定理', '定理误用'];
  if (/适用|前提|条件不满足/u.test(value)) return ['知识掌握', '公式定理', '适用条件不清'];
  if (/方法.*错|思路.*错|方法选择/u.test(value)) return ['思路方法', '方法选择', '方法选错'];
  if (/题型.*未识别|没看出.*题/u.test(value)) return ['思路方法', '方法选择', '未识别题型'];
  if (/分类讨论.*不全|少分|漏分类/u.test(value)) return ['思路方法', '构造转化', '分类讨论不全'];
  if (/特殊情形|特殊情况/u.test(value)) return ['思路方法', '完整性检查', '特殊情形遗漏'];
  if (/充分.*必要|必要.*充分/u.test(value)) return ['推理过程', '条件关系', '充分必要混淆'];
  if (/推理.*跳|逻辑.*跳|依据不足/u.test(value)) return ['推理过程', '逻辑链条', /依据/u.test(value) ? '依据不足' : '推理跳步'];
  if (/求导/u.test(value)) return ['计算执行', '专项计算', '求导错误'];
  if (/积分/u.test(value)) return ['计算执行', '专项计算', '积分错误'];
  if (/矩阵|行变换/u.test(value)) return ['计算执行', '专项计算', '矩阵变换错误'];
  if (/正负|符号/u.test(value)) return ['计算执行', '符号表达', '正负号错误'];
  if (/括号|下标|上标/u.test(value)) return ['计算执行', '符号表达', '括号下标错误'];
  if (/计算|算错|运算/u.test(value)) return ['计算执行', '运算错误', '算术计算错误'];
  if (/代数|变形/u.test(value)) return ['计算执行', '运算错误', '代数变形错误'];
  if (/化简|约分|通分/u.test(value)) return ['计算执行', '运算错误', '化简约分错误'];
  if (/时间|来不及/u.test(value)) return ['时间与策略', '时间分配', '未留检查时间'];
  if (/反应慢|不熟练/u.test(value)) return ['记忆提取', '熟练度不足', '反应过慢'];
  if (/忘记|想不起|记忆/u.test(value)) return ['记忆提取', '回忆失败', '公式想不起'];
  return ['其他', '信息不足', '尚未明确'];
};

export const wrongReasonPathForNote = (note: ClassifiableLearningNote): LearningClassificationPath => {
  const stored = canonicalizeRoot(note.wrongReasonPath, WRONG_REASON_ROOT_ALIASES);
  if (stored.length > 0) return stored;
  const tagged = taggedPath(note.tags, '错因路径:');
  if (tagged.length > 0) return tagged;
  return canonicalizeRoot(inferWrongReasonPath(firstUseful([
    note.wrongReason,
    ...(note.items ?? []).map((item) => item.wrongReason),
  ])), WRONG_REASON_ROOT_ALIASES);
};

const rawLearningTypePathForNote = (note: ClassifiableLearningNote): LearningClassificationPath => {
  const stored = canonicalizeRoot(note.learningTypePath, LEARNING_TYPE_ROOT_ALIASES);
  if (stored.length > 0) return stored;
  const tagged = taggedPath(note.tags, '学习类型:');
  if (tagged.length > 0) return tagged;
  const text = [note.title, note.remark, note.questionType, ...(note.tags ?? [])]
    .map(normalizeSegment)
    .join(' ');
  const subject = normalizeSegment(note.subject);
  if (subject === '英语') {
    if (/作文|写作|模板/u.test(text)) return ['语言积累', '写作模板'];
    if (/翻译/u.test(text)) return ['语言积累', '翻译表达'];
    if (/长难句|句子/u.test(text)) return ['语言积累', '长难句'];
    if (/语法/u.test(text)) return ['语言积累', '语法规则'];
    return ['语言积累', '单词短语'];
  }
  if (subject === '政治') {
    if (/时政|材料/u.test(text)) return ['政治材料', '时政材料'];
    if (/模板|答题/u.test(text)) return ['政治材料', '分析模板'];
    if (/原理/u.test(text)) return ['政治材料', '原理表述'];
    return ['政治材料', '核心概念'];
  }
  if (/易错|警示|注意|不要|避免/u.test(text)) return ['易错警示', '检查清单'];
  if (/结论|推论|规律/u.test(text)) return ['结论规律', '常用结论'];
  if (/边界|反例/u.test(text)) return ['结论规律', '边界反例'];
  if (/题型|解题|步骤|方法|构造|模板/u.test(text) || note.questionType) return ['题型方法', '标准步骤'];
  if (/公式|定理/u.test(text)) return ['纯知识', '公式定理'];
  if (/性质|条件/u.test(text)) return ['纯知识', '性质条件'];
  if (/原理|机制/u.test(text)) return ['纯知识', '原理机制'];
  return ['纯知识', '定义概念'];
};

export const learningTypePathForNote = (note: ClassifiableLearningNote): LearningClassificationPath => (
  canonicalizeRoot(rawLearningTypePathForNote(note), LEARNING_TYPE_ROOT_ALIASES)
);

export const goodQuestionTypeForNote = (note: ClassifiableLearningNote): string => {
  const stored = normalizeSegment(note.goodQuestionType);
  if ((GOOD_QUESTION_TYPES as readonly string[]).includes(stored)) return stored;
  const text = [note.title, note.remark, note.wrongReason, ...(note.tags ?? [])]
    .map(normalizeSegment)
    .join(' ');
  if (/新颖|创新|拓展|一题多解/u.test(text)) return '新颖拓展';
  if (/综合|压轴|多知识点/u.test(text) || (note.knowledgePath?.length ?? 0) > 2) return '综合提升';
  if (/易错|辨析|陷阱|错题/u.test(text) || Boolean(note.wrongReason)) return '易错辨析';
  if (/方法|技巧|构造|模板/u.test(text) || learningTypePathForNote(note)[0] === '题型方法') return '方法好题';
  return '经典母题';
};
