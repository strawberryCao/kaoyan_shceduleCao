const AI_408_SUBJECTS = Object.freeze([
  '数据结构',
  '计算机组成',
  '操作系统',
  '计算机网络',
]);

const AI_FALLBACK_SUBJECT = '默认文件夹';
const DEFAULT_BUCKET_NAMES = new Set(['默认文件夹', '未分类', '默认', '收件箱', '待归类']);

const SUBJECT_RULES = Object.freeze({
  数据结构: {
    aliases: ['数据结构与算法', '算法', 'DS'],
    keywords: [
      '数据结构', '时间复杂度', '空间复杂度', '线性表', '链表', '栈', '队列', '数组',
      '二叉树', '树的遍历', '图算法', '图的遍历', '最短路径', '拓扑排序', '查找',
      '排序算法', '哈希表', '散列表', 'B树', 'B+树',
    ],
  },
  计算机组成: {
    aliases: ['计算机组成原理', '组成原理', '计组', 'CO'],
    keywords: [
      '计算机组成', '组成原理', '指令系统', 'CPU', '处理器', '流水线', '存储器',
      '高速缓存', 'Cache', '主存', '虚拟存储器', '总线', '中断', 'DMA', '汇编',
      '补码', '浮点数', 'IO接口',
    ],
  },
  操作系统: {
    aliases: ['操作系统原理', 'OS'],
    keywords: [
      '操作系统', '进程', '线程', '调度算法', '进程调度', '死锁', '信号量', 'PV操作',
      '同步互斥', '临界区', '分页', '分段', '页表', '虚拟内存', '文件系统', '磁盘调度',
    ],
  },
  计算机网络: {
    aliases: ['计算机网络原理', '计网', '网络原理', '网络'],
    keywords: [
      '计算机网络', '网络协议', 'OSI', 'TCP', 'UDP', 'IP地址', 'IPv4', 'IPv6',
      'HTTP', 'HTTPS', 'DNS', 'DHCP', 'ARP', '路由算法', '路由器', '子网',
      '拥塞控制', '滑动窗口', '以太网', '数据链路', '传输层',
    ],
  },
});

function cleanText(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function lookupKey(value) {
  return cleanText(value)
    .replace(/[\s_\-/·、，,。；;：:（）()【】\[\]]+/g, '')
    .toLocaleLowerCase('zh-CN');
}

function canonicalAiSubject(value) {
  const target = lookupKey(value);
  if (!target) return null;
  for (const subject of AI_408_SUBJECTS) {
    const candidates = [subject, ...(SUBJECT_RULES[subject]?.aliases || [])];
    if (candidates.some((candidate) => lookupKey(candidate) === target)) return subject;
  }
  return null;
}

function isDefaultBucket(value) {
  return DEFAULT_BUCKET_NAMES.has(cleanText(value));
}

function taxonomySubjects(taxonomy) {
  return Array.isArray(taxonomy?.subjects) ? taxonomy.subjects : [];
}

function findTaxonomySubject(taxonomy, canonical) {
  // Subject aliases are model/user data and must not be able to promote an
  // unrelated node into the first-level allowlist. Accepted short forms (计网,
  // 计组, OS, etc.) are handled from the node's own name.
  return taxonomySubjects(taxonomy)
    .find((subject) => canonicalAiSubject(subject?.name) === canonical) || null;
}

function findFallbackSubject(taxonomy) {
  return taxonomySubjects(taxonomy).find((subject) => isDefaultBucket(subject?.name)) || null;
}

function collectSemanticText(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const values = [
    input?.requestedSubject,
    ...(Array.isArray(input?.subjectAliases) ? input.subjectAliases : []),
    input?.knowledgePoint,
    input?.questionType,
    input?.title,
    input?.summary,
    ...(Array.isArray(input?.tags) ? input.tags : []),
    ...items.flatMap((item) => [
      item?.title,
      item?.knowledgePoint,
      item?.questionType,
      item?.summary,
      ...(Array.isArray(item?.tags) ? item.tags : []),
    ]),
  ];
  return cleanText(values.filter(Boolean).join(' ')).toLocaleLowerCase('zh-CN');
}

function resolveAiSubject(taxonomy, input = {}) {
  const requestedCanonical = canonicalAiSubject(input.requestedSubject);
  const aliasCanonical = (Array.isArray(input.subjectAliases) ? input.subjectAliases : [])
    .map(canonicalAiSubject)
    .find(Boolean) || null;
  const directCanonical = requestedCanonical || aliasCanonical;
  if (directCanonical) {
    const node = taxonomy ? findTaxonomySubject(taxonomy, directCanonical) : null;
    if (!taxonomy || node) {
      return {
        subject: node?.name || directCanonical,
        canonical: directCanonical,
        node,
        fallback: false,
        reason: requestedCanonical ? 'direct' : 'alias',
      };
    }
  }

  const semanticText = collectSemanticText(input);
  let bestCanonical = null;
  let bestScore = 0;
  let tied = false;
  for (const canonical of AI_408_SUBJECTS) {
    const node = taxonomy ? findTaxonomySubject(taxonomy, canonical) : null;
    if (taxonomy && !node) continue;
    const keywords = SUBJECT_RULES[canonical]?.keywords || [];
    const score = keywords.reduce((total, keyword) => (
      semanticText.includes(cleanText(keyword).toLocaleLowerCase('zh-CN'))
        ? total + Math.max(1, Math.min(4, cleanText(keyword).length - 1))
        : total
    ), 0);
    if (score > bestScore) {
      bestCanonical = canonical;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  }
  if (bestCanonical && !tied) {
    const node = taxonomy ? findTaxonomySubject(taxonomy, bestCanonical) : null;
    return {
      subject: node?.name || bestCanonical,
      canonical: bestCanonical,
      node,
      fallback: false,
      reason: 'semantic',
    };
  }

  const currentCanonical = canonicalAiSubject(input.currentSubject);
  if (currentCanonical) {
    const node = taxonomy ? findTaxonomySubject(taxonomy, currentCanonical) : null;
    if (!taxonomy || node) {
      return {
        subject: node?.name || currentCanonical,
        canonical: currentCanonical,
        node,
        fallback: false,
        reason: 'current',
      };
    }
  }

  const fallbackNode = taxonomy ? findFallbackSubject(taxonomy) : null;
  return {
    subject: fallbackNode?.name || AI_FALLBACK_SUBJECT,
    canonical: null,
    node: fallbackNode,
    fallback: true,
    reason: tied ? 'ambiguous' : 'unknown',
  };
}

function filterTaxonomyForAi(taxonomy) {
  const source = taxonomy && typeof taxonomy === 'object' ? taxonomy : {};
  return {
    ...source,
    subjects: taxonomySubjects(source).filter((subject) => (
      Boolean(canonicalAiSubject(subject?.name))
      || isDefaultBucket(subject?.name)
    )),
  };
}

function pruneUnknownAiSubjects(taxonomy) {
  if (!taxonomy || !Array.isArray(taxonomy.subjects)) return [];
  const removed = taxonomy.subjects.filter((subject) => (
    subject?.createdBy === 'ai'
    && !canonicalAiSubject(subject?.name)
    && !isDefaultBucket(subject?.name)
  ));
  if (removed.length > 0) {
    const removedNodes = new Set(removed);
    taxonomy.subjects = taxonomy.subjects.filter((subject) => !removedNodes.has(subject));
  }
  return removed;
}

module.exports = {
  AI_408_SUBJECTS,
  AI_FALLBACK_SUBJECT,
  canonicalAiSubject,
  filterTaxonomyForAi,
  isDefaultBucket,
  pruneUnknownAiSubjects,
  resolveAiSubject,
};
