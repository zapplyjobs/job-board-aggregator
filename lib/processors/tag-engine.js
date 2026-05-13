/**
 * Tag Engine - Multi-layer job tagging
 *
 * Classification layers (in priority order):
 * 1. Department/team-based classification (highest confidence — company's own categorization)
 * 2. Title keyword matching (primary — all 16 domains)
 * 3. O*NET taxonomy lookup (fallback for general-tagged jobs — 12,084 title variants)
 * 4. Description phrase matching (fallback for GH/Lever/Ashby jobs with descriptions)
 * 5. Tenant-context defaults (per-company default_domain for verified single-domain companies)
 * 6. Default to 'general' if no layer matches
 *
 * Also tags: employment type, locations, experience level, special companies.
 */

const path = require('path');

// TAG-DRIFT-1: Version constant for carry-forward re-validation.
// Bump when keyword/guard/taxonomy changes alter classification behavior.
// The pipeline compares this to carry-forward jobs' tag version — if stale, re-tags domains.
const TAG_ENGINE_VERSION = 10;

// Layer 5: Tenant-context defaults from company-list.json (TAG-10)
// Claude-researched per-tenant domain assignments. Only for verified single-domain companies.
// Fires ONLY when all other layers (dept, keywords, O*NET, desc-fallback) produce no match.
const TENANT_DEFAULTS = (() => {
  try {
    const cl = require(path.join(__dirname, '..', 'fetchers', 'company-list.json'));
    const map = new Map();
    for (const ats of Object.values(cl)) {
      if (!Array.isArray(ats)) continue;
      for (const entry of ats) {
        if (entry.default_domain) {
          // Slug must match the fetcher's company_slug output exactly.
          // GH/Lever/Ashby/SR: entry.slug is already the canonical slug.
          // WD: no slug field — must match WD fetcher's tenantName.toLowerCase().replace(/\s+/g, '-')
          let slug;
          if (entry.slug) {
            slug = entry.slug.toLowerCase();
          } else if (entry.name) {
            slug = entry.name.toLowerCase().replace(/\s+/g, '-');
          }
          if (slug) map.set(slug, entry.default_domain);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
})();

// O*NET unified domain lookup — 28,486 title variants mapped to our domains via SOC codes.
// Source: O*NET v29.1 (public domain, CC BY 4.0). See TAG_CLASSIFICATION_RESEARCH_.md.
// Two matching methods: substring for 3+ word titles, word-boundary regex for 2-word titles.
// Word-indexed for fast candidate filtering.
const ONET = (() => {
  try {
    const data = require(path.join(__dirname, 'onet-unified-lookup.json'));

    // 3+ word titles: substring matching, word-indexed
    const substringEntries = data.substring || [];
    const substringWordIndex = new Map();
    substringEntries.forEach(([title], idx) => {
      for (const word of title.split(/\s+/)) {
        if (word.length < 4) continue;
        if (!substringWordIndex.has(word)) substringWordIndex.set(word, []);
        substringWordIndex.get(word).push(idx);
      }
    });

    // 2-word titles: word-boundary regex, first-word-indexed
    const regexEntries = [];
    const regexWordIndex = new Map();
    for (const [title, domain] of (data.regex || [])) {
      const re = new RegExp('\\b' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      const idx = regexEntries.length;
      regexEntries.push({ title, domain, re });
      const firstWord = title.split(/\s+/).find(w => w.length >= 4) || title.split(/\s+/)[0];
      if (!regexWordIndex.has(firstWord)) regexWordIndex.set(firstWord, []);
      regexWordIndex.get(firstWord).push(idx);
    }

    return { substringEntries, substringWordIndex, regexEntries, regexWordIndex };
  } catch {
    console.warn('tag-engine: onet-unified-lookup.json not found — O*NET fallback disabled');
    return { substringEntries: [], substringWordIndex: new Map(), regexEntries: [], regexWordIndex: new Map() };
  }
})();

/**
 * Tag a single job with all tag categories
 * @param {Object} job - Normalized job object
 * @returns {Object} - Job with tags property added
 */
function tagJob(job) {
  const taggedJob = { ...job };

  const employment = tagEmployment(job);
  taggedJob.tags = {
    employment,
    domains: tagDomains(job),
    locations: tagLocations(job),
    // Internships default to entry_level — description context ("our team has 5+ years")
    // causes false senior/mid tags on intern jobs via year-mention detection
    experience: employment === 'internship' ? 'entry_level' : tagExperience(job),
    special: tagSpecial(job),
    tag_engine_version: TAG_ENGINE_VERSION,
  };

  return taggedJob;
}

/**
 * Tag an array of jobs
 * @param {Array} jobs - Job array
 * @returns {Array} - Jobs with tags
 */
function tagJobs(jobs) {
  if (!Array.isArray(jobs)) {
    console.warn('tagJobs: Expected array, got', typeof jobs);
    return [];
  }

  return jobs.map(job => tagJob(job));
}

// Regex patterns for tagEmployment — defined once at module scope, not recreated per call.
// Entry-lock: explicit new-grad/junior title signals force entry_level before seniority checks.
const ENTRY_LOCK_RE = /\b(new\s+grad|new\s+graduate|university\s+grad|campus\s+hire|early[\s-]career|entry[\s-]level|junior|trainee|associate\s+(?:engineer|developer|analyst|scientist|researcher)|assistant\s+(?:vice\s+president|vp)|sr\.?\s*associate|senior\s+associate|principal\s+associate|executive\s+assistant)\b/i;
// TAG-24: senior/principal associate — finance/consulting mid-level (2-4 yrs), not senior
// TAG-25: executive assistant — admin/entry-level role, not senior
// Mid-level: Roman numeral suffix II/III or explicit labels. Uses lookbehind/lookahead to avoid
// substring matches like 'Hawaii' (ha-waii) or 'viii'. \b alone is insufficient for 'ii' at end of word.
const MID_TITLE_RE = /(?<![a-z])(ii|iii)(?![a-z])|\b(sde\s*2|swe\s*2|l4|mid[\s-]level|intermediate)\b/i;
// Senior additions beyond existing keyword includes.
const SENIOR_EXTRA_RE = /\b(architect|distinguished|director|vp|vice\s+president)\b/i;

// TAG-KEYWORD-7: Senior engineering management — reconciled with senior-filter.js.
// "manager" alone is NOT senior (Account Manager, Product Manager, etc.). Only
// people-managers of engineering/technical teams are senior.
const SENIOR_MANAGER_RE = /\b(engineering\s+manager|software\s+engineering\s+manager|ml\s+manager|machine\s+learning\s+manager|manager,?\s+(?:software\s+)?engineering|data\s+engineering\s+manager|solution\s+engineering\s+manager|sales\s+engineering\s+manager)\b(?!.*\bI\b)/i;

// AGG-36: Per-company employment override map (set by tagJobs, read by tagEmployment).
// Format: Map<companyName_lowercase, { regex: RegExp, result: string }[]>
let _companyOverrideMap = null;

/**
 * AGG-36: Set per-company override map. Called by pipeline before tagJobs.
 * Map format: Map<companyName_lowercase, { regex: RegExp, result: string }[]>
 */
function setCompanyOverrideMap(overrideMap) {
  _companyOverrideMap = overrideMap;
}

/**
 * Tag employment type (mutually exclusive)
 * Priority: internship > entry_lock > senior > mid_level > entry_level
 *
 * entry_lock fires before senior/mid so "Junior Architect" stays entry_level.
 * mid_level uses word-boundary regex (not includes) so 'ii' doesn't match 'Hawaii'.
 */
function tagEmployment(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const employmentType = (job.employment_type || '').toLowerCase();

  // Check for internship (highest priority)
  // INTERN-DETECT-1: expanded to catch co-op, graduate engineer, seasonal programs
  // Uses word boundary \b to avoid "Internal Medicine" matching "intern"
  const internWordRegex = /\b(interns?|internships?|co-ops?|coops?)\b/i;
  const seasonalRegex = /\b(summer|fall|spring|winter)\s+20\d{2}\b/i;
  const seasonalGrad = /\b(summer|fall|spring|winter)\s+20\d{2}\s+graduate\b/i;

  if (internWordRegex.test(job.title || '') || seasonalRegex.test(job.title || '') || seasonalGrad.test(job.title || '')) {
    // Filter fake internships: senior-level title + "intern" is contradictory
    const fakePatterns = ['senior intern', 'sr. intern', 'principal intern', 'intern conversion'];
    const isFakeIntern = fakePatterns.some(pattern => title.includes(pattern));

    if (!isFakeIntern) {
      return 'internship';
    }
  }

  // Entry-lock: explicit new-grad/junior signals override seniority detection
  if (ENTRY_LOCK_RE.test(job.title || '')) {
    return 'entry_level';
  }

  // AGG-36: Per-company title override (between entry-lock and global senior keywords).
  // If a company-specific pattern matches, use that result instead of global rules.
  if (_companyOverrideMap && job.company_name) {
    const rules = _companyOverrideMap.get(job.company_name.toLowerCase());
    if (rules) {
      for (const rule of rules) {
        if (rule.regex.test(job.title || '')) {
          return rule.result;
        }
      }
    }
  }

  // TAG-PRECISION-6: Entry-level guards for ambiguous senior keywords.
  // Reconciled with senior-filter.js ENTRY_LEVEL_GUARDS (same patterns, same logic).
  // These override a senior keyword match when the title context is actually entry/mid-level.
  const SENIOR_GUARD_PATTERNS = [
    /\bstaffing\b/i,                       // "Staffing Coordinator" — not "Staff Engineer"
    /\blead\s+generation\b/i,              // marketing role, not leadership
    /\bshift\s+lead\b/i,                   // hourly production roles
    /\bteam\s+lead\b(?!.*(?:engineer|software|developer|architect))/i,  // mfg/retail team leads, not "Team Lead - Software"
    /\b(solution|solutions|business|sales|presales|pre-sales)\s+architect\b/i,  // pre-sales/consulting — mid-level professional
    /\barchitect\b.*\b(solution|solutions|business|sales|presales|pre-sales)\b/i,  // "Architect, Solutions" variant
  ];
  // Architect-specific guards produce mid_level (professional role with experience requirements).
  // Other guards (staffing, lead gen, shift lead, team lead) produce entry_level (admin/hourly roles).
  const ARCHISTECT_GUARD_RE = /\b(solution|solutions|business|sales|presales|pre-sales)\s+architect\b|\barchitect\b.*\b(solution|solutions|business|sales|presales|pre-sales)\b/i;

  // Check for senior level
  const matchedSenior = (title.includes('senior') || title.includes('sr.') || title.includes('sr ') ||
      title.includes('principal') || (title.includes('staff') && !title.includes('staffing')) || title.includes('lead') ||
      SENIOR_EXTRA_RE.test(job.title || '') ||
      SENIOR_MANAGER_RE.test(job.title || ''));

  if (matchedSenior) {
    // Check guards — if any match, this is NOT a senior title
    const guarded = SENIOR_GUARD_PATTERNS.some(pat => pat.test(job.title || ''));
    if (!guarded) {
      return 'senior';
    }
    // Architect guards: pre-sales/consulting roles are mid-level professionals (3-5 yrs exp),
    // not entry-level. Other guards (staffing, shift lead, etc.) correctly default to entry_level.
    if (ARCHISTECT_GUARD_RE.test(job.title || '')) {
      return 'mid_level';
    }
  }

  // Check for mid-level (word-boundary regex prevents 'ii' matching 'Hawaii' etc)
  if (title.includes('mid') || title.includes('mid-level') || title.includes('mid level') ||
      MID_TITLE_RE.test(job.title || '')) {
    return 'mid_level';
  }

  // Default to entry level
  return 'entry_level';
}

/**
 * Tag domains (multi-select)
 * Returns array of matching domains
 */
function tagDomains(job, options) {
  const debug = options && options.debug;
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const tags = [];
  const matches = debug ? [] : null;

  // Debug helper: find which keyword matched in a list
  function findMatch(keywords, text) {
    for (const kw of keywords) {
      if (text.includes(kw)) return kw;
    }
    return null;
  }
  function pushTag(domain, keyword, source) {
    tags.push(domain);
    if (matches) matches.push({ domain, keyword: keyword || (domain === 'general' ? '(no match)' : '(regex)'), source: source || 'title' });
  }

  // Department/team-based classification (highest confidence — company's own categorization).
  // GH: departments[], Lever: team, Ashby: department + team. Checked BEFORE title keywords
  // because the company's classification is more reliable than keyword inference.
  // RULE ORDER MATTERS: first match wins (break on match). More specific rules must come
  // before broader ones — e.g., 'product engineering' → software before 'product' → product.
  const deptRaw = (job.team || job.department || (job.departments && job.departments[0]) || '').toLowerCase();
  if (deptRaw) {
    const DEPT_RULES = [
      // Trailing \b kept on rules with short patterns (it, ui) to prevent substring FPs.
      // 'XXX engineering' forms added explicitly where 'XXX eng\b' missed the full word.
      [/\b(software|platform engineer(?:ing)?|web engineer(?:ing)?|mobile engineer(?:ing)?|data engineer(?:ing)?|backend|frontend|devops|sre|infra engineer(?:ing)?|security engineer(?:ing)?|it engineer(?:ing)?|product engineer(?:ing)?|it)\b|\b(product (?:development|support|security|solutions))\b|\bengineering\s*[&,]\s*product\b|\bengineering\s+product\b|\b(epd)\b/i, 'software'],
      [/\b(machine learning|artificial intelligence|ai |data science|ml engineer(?:ing)?)\b/i, 'ai'],
      [/\b(data anal|business intel|analytics)\b/i, 'data_science'],
      [/\b(hardware|electrical|mechanical|embedded|firmware|test engineer(?:ing)?|systems engineer(?:ing)?|materials engineer(?:ing)?)\b/i, 'hardware'],
      [/\b(sales|business develop|account exec|revenue)\b/i, 'sales'],
      [/\b(marketing|brand|content|growth|creative|communications)\b/i, 'marketing'],
      [/\b(finance|accounting|treasury|tax |fp&a|financial|actuarial)\b/i, 'finance'],
      [/\b(legal|compliance|regulatory|counsel)\b/i, 'legal'],
      // domain-accuracy audit: removed 'people' and 'talent' as standalone triggers.
      // 'People' dept name is used by tech companies for all non-eng functions — EAs, admins, recruiters.
      // Only explicit HR terms are safe as dept-level signals.
      [/\b(human resources|human resource|recruiting|hr )\b/i, 'hr'],
      [/\b(operations|ops |customer (experience|success|care|support)|fleet|supply chain|cx|field service)\b/i, 'operations'],
      // 'Engineering / Design / Projects' dept (Veolia) was matching product — civil/mech engineering roles.
      // 'design' only valid as product signal when paired with ux/ui context.
      [/\b(product)\b|\b(ux|ui)\b|\bdesign\b(?=.*\b(ux|ui|user experience|product)\b)/i, 'product'],
      [/\b(manufacturing|production|assembly|quality)\b/i, 'manufacturing'],
      [/\b(healthcare|clinical|medical|nursing|pharma)\b/i, 'healthcare'],
      [/\b(warehouse|logistics|distribution|shipping|transport)\b/i, 'logistics'],
      [/\b(retail|store|merchandis)\b/i, 'retail'],
    ];
    for (const [re, domain] of DEPT_RULES) {
      if (re.test(deptRaw)) {
        // TAG-GUARD-1: "Hardware Operations : Supply Chain" dept names match hardware regex
        // before operations/supply chain regex can fire. Supply chain/procurement depts are
        // operations, not hardware — skip hardware match and let operations rule fire.
        if (domain === 'hardware' && /\b(supply chain|procurement)\b/i.test(deptRaw)) {
          continue;
        }
        // TAG-GUARD-4: DEPT_RULES software overclassification guards. Three patterns cause FPs:
        //
        // 1. Bare \b(it)\b matches any "IT" dept — IT Support, Corp IT, IT Infrastructure.
        //    These are operations/admin roles, not software. Only "IT Engineering" depts build software.
        //    Fix: skip when \b(it)\b is the match AND dept contains non-engineering IT context.
        if (domain === 'software' && /\bit\b/i.test(deptRaw) && !/\bit engineer/i.test(deptRaw)) {
          continue;
        }
        // 2. "Mobile Engineering" dept at SpaceX is cellular/wireless hardware, not mobile app dev.
        //    "Starlink Mobile Engineering" produces RF, mechanical, electrical engineers.
        //    Fix: skip when dept contains mobile engineering AND hardware org keywords.
        if (domain === 'software' && /\bmobile engineer/i.test(deptRaw) && /\b(starlink|wireless|rf|antenna|cell)\b/i.test(deptRaw)) {
          continue;
        }
        // 3. "Product Engineering" dept at SpaceX/John Deere is hardware/manufacturing, not software.
        //    "Starlink Product Engineering" produces mechanical, electrical, RF, compliance engineers.
        //    "Product Engineering (CA)" at John Deere produces part-time student roles.
        //    Fix: skip when dept has product engineering AND hardware org context OR non-SW company context.
        if (domain === 'software' && /\bproduct engineer/i.test(deptRaw) && /\b(starlink|deere)\b/i.test(deptRaw)) {
          continue;
        }
        pushTag(domain, '(dept: ' + deptRaw.substring(0, 30) + ')', 'department');
        break;
      }
    }
  }

  // Software domain (removed bare 'developer' — too broad, matches 'developer relations', 'developer advocate')
  const softwareKeywords = [
    'software engineer', 'software developer', 'full stack', 'fullstack',
    'frontend', 'back end', 'backend', 'web developer', 'web dev',
    'mobile developer', 'ios developer', 'android developer',
    'devops', 'site reliability', 'platform engineer',
    // Intern-specific patterns missed by above (INTERN-1 fix):
    'software intern', 'systems engineer', 'computer engineer', 'computer engineering',
    'cybersecurity', 'cyber security', 'information technology',
    'information security', 'cloud engineer',
    // INTERN-1a Wave 2: additional patterns from Strategist simulation (196 reclassifications)
    'security engineer', 'infrastructure engineer', 'compiler', 'middleware', 'flight software',
    // TAG-KEYWORD-11: 'it service' removed (100% FP — IT Service Level Manager, IT Services Technician).
    // TAG-KEYWORD-11: 'it systems' removed (75% FP — IT Systems Administrator, IT Systems & A/V Engineer).
    //   Borderline "IT Systems Engineer" preserved via O*NET fallback (genuine SRE/infra roles).
    //   Pre-O*NET guard blocks admin/AV/ops variants from O*NET software re-classification.
    'cyber incident', 'threat detection', 'threat investigation',
    'red team', 'product security', 'support engineer', 'technical support engineer',
    'ai automation', 'software development engineer',
    'developer experience', 'datapath engineer', 'application developer',
    'automation developer', 'internet measurement', 'digital engineer',
    'enterprise architecture analyst',
    // TAG-OVERHAUL-A additions:
    'servicenow',                   // ServiceNow — guarded: only developer/engineer roles (TAG-KEYWORD-10)
    'software quality assurance',   // SW QA — explicit software testing roles
    'sw qa',                        // abbreviated form
    'information systems security', // ISSO — infosec role, distinct from physical 'security officer'
 // FRESHNESS-3: GH general-tagged misclassification fixes (Auditor data audit — 14 confirmed misses)
    'perception engineer',          // Robotics/AI perception (Anduril) — software domain
    'it infrastructure engineer',   // IT infra (Vercel) — software domain
    'full-stack engineer',          // hyphenated form missed by 'full stack' keyword
 // TAG-CATEGORY-REDESIGN Option 2 (Strategist vocabulary audit — ~120 general+US reclassifications)
    'solutions engineer',           // 48 hits — tech/pre-sales/defense tech (isSalesRole guard blocks 'sales solutions engineer')
    'systems analyst',              // 43 hits — IT/business systems analysis
    'technical operations engineer',// 15 hits — Anduril defense tech ops
    'qa engineer',                  // ~9 hits — SW QA (safe bare pattern; 'quality assurance engineer' bare is NOT added — manufacturing FP risk)
    'test automation engineer',     // ~4 hits — SW test automation
    'network automation engineer',  // ~4 hits — IT network automation
    'software automation engineer', // ~3 hits — SW automation
    'programmer analyst',           // ~6 hits — Boeing/defense SW programmer-analysts
 // TAXONOMY-AUDIT-1: general-tagged engineering roles
    'project engineer',             // 163 hits — engineering project roles (guard: not sales/manufacturing)
    'integration engineer',         // 90 hits — systems integration (defense/tech)
 // TAG-MISROUTE-1 Issue 3b: keywords added to compensate for removing description fallback
    'forward deployed engineer',    // 26 hits — Palantir/Glean/Commure (was caught by desc only)
    'systems development engineer', // 14 hits — Amazon SDE variant
    'android engineer',             // 13 hits — mobile dev (was caught by desc only)
    'ios engineer',                 // 10 hits — mobile dev (was caught by desc only)
    'linux engineer',               // 13 hits — systems/infra
    'solution engineer',            // 84 hits — singular form missed by 'solutions engineer'
    'technical services engineer',  // 10 hits — tech support engineering
    'professional services engineer', // 4 hits — implementation engineering
    'data center engineer',         // DC infra/operations engineering (software-adjacent)
    'data center administrator',    // DC admin roles (DCIM, infrastructure)
    'data center analyst',          // DC operations analysis
    'data center database',         // DC database admin roles
    // NOTE: bare 'data center' removed — matched facilities/safety roles (14 DC Technician, 8 Safety Engineer FPs)
    'research engineer',            // 72 hits — ML/AI research (OpenAI, Anduril, KBR)
    'automation engineer',          // 36 hits — SW/infra automation (guard: not HVAC/building)
    'desktop support',              // 11 hits — IT desktop support
    'security analyst',             // 13 hits — infosec analyst (guard: not physical security)
    'customer engineer',            // 21 hits — technical customer-facing (Google, etc.)
    'engineering intern',           // 76 hits — general eng interns at tech cos (guard: not mech/civil/chem)
    'network admin',                // 6 hits — network administration
    'devsecops',                    // 6 hits — DevSecOps engineer (defense/gov)
    'reverse engineer',             // 5 hits — software reverse engineering
    'simulation engineer',          // 15 hits — M&S engineer (defense/tech)
    'database administrator',       // 16 hits — DBA roles
    'database engineer',            // 4 hits — database engineering
    'splunk',                       // 3 hits — Splunk engineer/admin (SIEM)
    'technical program manager',    // 6 hits — TPM roles (Cloudflare, Astranis)
    'cloud system',                 // 2 hits — cloud systems engineer
    'microsoft dynamics',           // 8 hits — ERP development/consulting
    'power apps',                   // 4 hits — low-code platform development
    'information system security',  // 6 hits — ISSO/infosec role
    '.net developer',               // 7 hits — .NET framework development
    '.net engineer',                // .NET engineering roles
    'asp.net',                      // ASP.NET web development
    'systems specialist',           // 20 hits — IT systems specialist
    'cloud developer',              // 3 hits — cloud infrastructure development
    'bi developer',                 // 2 hits — business intelligence development
    'unity developer',              // 2 hits — Unity game/simulation development
    'integration developer',        // 2 hits — systems integration development
    'configuration management',     // 4 hits — CM/DevOps roles
    'network implementation',       // 2 hits — network deployment engineering
    'uipath developer',             // 1 hit — RPA development
    'drupal developer',             // 1 hit — CMS development
    'program manager',              // 8 gen, 88% spec — technical program management
    'deployment strategist',        // 6 gen — deployment/field strategist roles
    'configuration analyst',        // 3 gen — IT configuration analysis
    'network automation',           // 4 gen — bare form (had only 'network automation engineer')
    'security researcher',          // 1 gen — security research roles (OpenAI)
    'compositing developer',        // 2 gen — VFX compositing (DreamWorks)
    'manual tester',                // 2 gen — manual QA testing
    'geospatial',                   // 1 gen — geospatial development
    'cyber intern',                 // 2 gen — cybersecurity internships
    'security operations center',   // 2 gen — SOC operators/analysts
    'cyber capability',             // 1 gen — cyber capability development
    'computer support',             // 1 gen — computer/IT support
    'command center',               // 1 gen — command center operations
    'information assurance',        // 2 gen — IA/ISSO roles
    'cyberspace',                   // 1 gen — cyberspace operations
    // C58: security/IAM keyword gaps
    'sql engineer',               // 3 gen — SQL engineering roles
    'detection and response',     // 3 gen — D&R security roles (e.g. "Detection and Response Engineer")
    'graphics engineer',          // 2 gen — graphics/XR engineering
    'endpoint detection',         // 1 gen — EDR specialist
    'access management',          // 1 gen — IAM engineering (e.g. "Identity & Access Management Engineer")
    'identity and access',        // 1 gen — IAM roles (covers 'Identity & Access Management')
    'machine identity',           // 1 gen — machine identity engineering
    'web app developer',          // 1 gen — web application development
    'openshift',                  // C58 gap — container platform engineering
    'cyber analytics',            // 1 gen — cyber analytics integration
    'digital forensics',            // 1 gen — digital forensics engineering
    'cyber threat',                 // 4 gen — cyber threat analysts
    'presale engineer',             // 1 gen — singular form (had 'presales')
    'escalations engineer',         // 2 gen — escalation engineering
    'threat model',                 // 2 gen — threat modeling
    'release engineer',             // 4 gen — release engineering
    'jr. programmer',               // 1 gen — junior programmer
    'jr developer',                 // 1 gen — junior developer
    'implementation engineer',      // 4 gen — implementation/deployment engineering
    'engineering manager',          // 2 gen — engineering management
    'developer relations',          // 4 gen — DevRel engineering
    'it operations',                // 3 gen — IT operations roles
    'front-end developer',          // 1 gen — hyphenated form (had 'frontend' but not 'front-end developer')
    'full-stack developer',         // 1 gen — hyphenated form (had 'full-stack engineer' but not developer)
    'power platform developer',     // 3 gen — Microsoft Power Platform development
    'cyber warfare',                // 2 gen — cyber warfare engineering (Booz Allen)
    'developer advocate',           // 2 gen — DevRel advocacy roles
    'internationalization engineer', // 1 gen, 0 FP — i18n engineering (Netflix)
    'broadcom administrator',        // 2 gen, 0 FP — VMware/Broadcom admin
    'itsm administrator',            // 1 gen, 0 FP — ITSM/ServiceNow admin
    'application administrator',     // 1 gen, 0 FP — application admin
    'patching engineer',             // 1 gen, 0 FP — patch management engineering
    'noc engineer',                  // 2 gen, 0 FP — network operations center
    'automated remediation',         // 1 gen, 0 FP — IT automated remediation
    'network operations center',     // 1 gen, 0 FP — NOC roles
    'mission it',                    // 1 gen, 0 FP — mission IT operator (defense)
    'computer network operator',     // 1 gen, 0 FP — CNO roles (defense)
    'infrastructure watch',          // 1 gen, 0 FP — NOSC infrastructure watch
    'mumps developer',               // 1 gen, 0 FP — MUMPS/M programming
    'linux system engineer',         // 1 gen, 0 FP — Linux syseng
    'prisma access',                 // 1 gen, 0 FP — Palo Alto Prisma Access
    'm365 platform',                 // 1 gen, 0 FP — M365 platform owner
    'network firewall engineer',     // 1 gen, 0 FP — firewall engineering
    'cno developer',                 // 1 gen, 0 FP — computer network operations dev
    'cno analyst',                   // 2 gen, 0 FP — CNO analyst/programmer
    'helpdesk technician',           // 1 gen, 0 FP — helpdesk tech
    'cyber infrastructure',          // 1 gen, 0 FP — cyber infrastructure specialist
    'gcp cyber',                     // 1 gen, 0 FP — GCP cyber engineer (USAF Cloud One)
    'network monitor',               // 1 gen, 0 FP — network monitor specialist
    'netops specialist',             // 1 gen, 0 FP — network operations specialist
    'noc technician',                // 1 gen, 0 FP — NOC technician
    'cross domain implementation',   // 1 gen, 0 FP — cross domain analyst
    'celonis developer',             // 1 gen, 0 FP — Celonis process mining
    'workday integrations',          // 1 gen, 0 FP — Workday integrations
    'cyber risk assessment',         // 1 gen, 0 FP — cyber risk assessment analyst
    'crowds artist',                    // 1 gen, 0 FP — VFX crowds artist (Disney)
    'pc garage',                        // 1 gen, 0 FP — PC garage technician (GM)
    'cognos administrator',             // 1 gen, 0 FP — Cognos BI admin (FLIR)

    'sap functional',                // 1 gen, 0 FP — SAP functional FI/CO analyst
    'firewall engineer',             // 1 gen, 0 FP — firewall engineering (bare form)
    'computational imaging',         // 1 gen, 0 FP — computational imaging research
    'cloud operations engineer',     // blocks O*NET hardware match for cloud ops roles
    'ml framework engineer',         // 1 gen, 0 FP — ML framework engineering
    'distributed training engineer', // 1 gen, 0 FP — distributed training (Sora)
    'detection & mitigation',       // 1 gen, 0 FP — detection & mitigation engineering
    'developer educator',           // 1 gen, 0 FP — developer education
    'workday functional',           // 1 gen, 0 FP — Workday functional specialist
    'ai security consultant',       // 1 gen, 0 FP — AI security consulting
    'data protection analyst',      // 2 gen, 0 FP — data protection analysis
    'ng siem',                      // 1 gen, 0 FP — next-gen SIEM
    'technology evangelist',        // 1 gen, 0 FP — technology evangelist (Motorola)
    'premierone',                   // 1 gen, 0 FP — PremierOne records (Motorola)
    'civil construction software',  // 1 gen, 0 FP — civil construction software (Trimble)
    'erp business advisor',         // 1 gen, 0 FP — ERP business advisor (Trimble)
    'coupa support',                // 1 gen, 0 FP — Coupa support network (Caterpillar)
    'saas governance',              // 1 gen, 0 FP — SaaS governance (Prudential)
    'sdn enterprise',               // 1 gen, 0 FP — SDN enterprise engineer (AIG)
    'fix onboarding',               // 1 gen, 0 FP — FIX protocol onboarding (Broadridge)
    'it/ot infrastructure',         // 1 gen, 0 FP — IT/OT infrastructure (Elanco)
    'dynamics 365',                 // 1 gen, 0 FP — Dynamics 365 developer
    'threat collections',           // 1 gen, 0 FP — threat collections engineer (Anthropic)
    'mixed reality developer',      // 1 gen, 0 FP — mixed reality development (Palantir)
    'field ciso',                   // 1 gen, 0 FP — field CISO (F5)
    'endpoint engineer',            // 1 gen, 0 FP — endpoint engineering (Genentech)
    'power platform consultant',    // 1 gen, 0 FP — Power Platform consultant (Guidehouse)
    'ai governance',                // 1 gen, 0 FP — AI governance specialist (Guidehouse)
    'interface sustainment',         // 2 gen — interface sustainment analyst (IT role)
    'sharepoint farm',              // 1 gen, 0 FP — SharePoint Farm Admin (CACI IT)
    'hbss',                         // 1 gen, 0 FP — HBSS/ESS Administrator (CACI IT)
    'pl/sql developer',             // 1 gen, 0 FP — PL/SQL Developer (CACI IT)
    'sap master data',              // 1 gen, 0 FP — SAP Master Data Governance SME (CACI IT)
    'ai context',                   // 1 gen, 0 FP — AI Context Engineer (CACI IT)
    'application monitoring',       // 1 gen, 0 FP — 24/7 Application Monitoring (CACI IT)
    'network access control',       // 1 gen, 0 FP — Network Access Control Engineer (CACI IT)
    'vulnerability management',     // 2 gen, 0 real FP — pre-existing ops misclassification (Astranis/Workday)
    'risk management framework',    // 1 gen, 0 FP — RMF Expert (Guidehouse Cyber)
    'rmf expert',                   // 1 gen, 0 FP — RMF Expert (Guidehouse Cyber, title-specific guard)
    'secops',                       // 1 gen, 0 FP — VulnMgmt & SecOps Specialist (Guidehouse)
    'icam',                         // 1 gen, 0 real FP — ICAM Eng (BAH ops misclassification)
    'microsoft power platform',     // 1 gen, 0 FP — Power Platform Consultant (Guidehouse)
    'multiplatform planning',       // 1 gen, 0 FP — Multiplatform Planning & Strategy (NBCUniversal)
    'on-platform strategy',         // 1 gen, 0 FP — On-Platform Strategy Specialist (NBCUniversal)
    'lighting and look dev',        // 1 gen, 0 FP — Lighting & Look Dev Tools Engineer (DreamWorks)
    'look dev tools',               // 1 gen, 0 FP — Look Dev Tools Engineer (DreamWorks, broader guard)
    'system integration technician', // 1 gen, 0 FP — System Integration Tech (NBCUniversal broadcast)
    'integration designer',         // 1 gen, 0 FP — Integration Designer (NBCUniversal)
    'sap ariba',                    // 1 gen, 0 FP — SAP Ariba Cloud Integration Gateway Developer (RTX)
    'digital technology intern',    // 2 gen, 0 FP — Digital Technology Internship (RTX, Carrier)
    'maximo administrator',         // 1 gen, 0 FP — Maximo Administrator (Disney Parks)
    'set extension artist',         // 1 gen, 0 FP — Set Extension Artist (Disney Animation CG)
    'it technician',                // 1 gen, 0 FP — IT Technician 1st shift (Bosch)
    'bts process analyst',          // 1 gen, 0 FP — BTS (Business Technology Solutions) Process Analyst (AbbVie)
    'digital strategy lead',        // 1 gen, 0 FP — Associate Director Digital Strategy Lead Biologics (AbbVie)
    'r&d information research',     // 1 gen, 0 FP — AD R&D Information Research IT (AbbVie)
    'tanium engineer',              // 1 gen, 0 FP — Tanium Engineer (CACI IT)
    'sipr beyondtrust',             // 1 gen, 0 FP — SIPR BeyondTrust Engineer (CACI IT)
    'stripes/paces',                // 1 gen, 0 FP — STRIPES/PACES Specialist (CACI IT)
    'network management/administrator', // 1 gen, 0 FP — Network Management/Administrator L3 (CACI IT)
    'sap data services',            // 1 gen, 0 FP — SAP Data Services Consultant (CACI)
    'data systems & policy',        // 1 gen, 0 FP — Data Systems & Policy Analyst (CACI IT)
    'infrastructure monitoring tools', // 1 gen, 0 FP — Infrastructure Monitoring Tools Specialist (CACI IT)
    'dashboard developer',          // 1 gen, 0 FP — Dashboard Developer (Booz Allen)
    'desktop engineer',             // 1 gen, 0 FP — Desktop Engineer (Leidos IT)
    'detection engineering',        // 2 gen, 0 FP — Principal Associate Detection Engineering (Capital One), Security Engineer Detection Engineering (Asana)
    'cyber controls',               // 1 gen, 0 FP — Cyber Controls Monitoring Analyst (Capital One)
    'it security',                  // 3 gen→1 gen, 2 already-sw — Engineer IT Security (Northrop Grumman), IT Security Engineer (Jane Street x2)
    'network communications administrator', // 1 gen, 0 FP — Network Communications Administrator (Northrop Grumman)
    'cyber sys engineer',           // 3 gen→2 gen, 1 already-sw — Cyber Sys Engineer (Northrop Grumman)
    'it infrastructure administrator', // 1 gen, 0 FP — IT Infrastructure Administrator (Northrop Grumman)
    'sharepoint designer',          // 1 gen, 0 FP — SharePoint Designer/Developer (Guidehouse)
    'archibus',                     // 1 gen, 0 FP — Archibus Project Advisor (Guidehouse) [CAFM software]
    'ediscovery technical',         // 1 gen, 0 FP — eDiscovery Technical Advisor (Guidehouse)
    'microsoft developer',          // 1 gen, 0 FP — Microsoft Developer (Guidehouse)
    'intermediate developer',       // 1 gen, 0 FP — Intermediate Developer Specialist (Guidehouse)
    'logistics it',                 // 1 gen, 0 FP — Logistics IT and Acquisition Consultant (Guidehouse)
    'access management (iam)',      // 2 gen→1 gen, 1 already-sw — IAM Engineer (Guidehouse), Platform Engineer IAM (Palantir)
    'health technology consulting', // 1 gen, 0 FP — Associate Director, Health Technology Consulting, Revenue Cycle Technology (Guidehouse)
    'revenue cycle technology',     // 1 gen, 0 FP — Associate Director, Health Technology Consulting, Revenue Cycle Technology (Guidehouse) [EHR/RCM software implementation]
    'advanced ux',                  // 2 gen, 0 FP — Designer Advanced UX team / Insight (General Motors) [UX design = software domain]
    'ai cgi',                       // 1 gen, 0 FP — AI CGI Specialist Design Visualization (General Motors)
    'aftermarket digital',          // 1 gen, 0 FP — Aftermarket Digital Specialist (Caterpillar) [Career Area: Product Support — digital tools for equipment service]
    'technical infrastructure',     // 1 gen, 0 FP — IT Analyst - Technical Infrastructure (Caterpillar) [Career Area: Technology, Digital and Data]
    'decision support',             // 1 gen, 0 FP — Decision Support Tools Engineer (Abbott)
    'qa tester',                    // 1 gen, 0 FP — QA Tester (WBD/NetherRealm game studio; game QA = software testing)
    'workforce support technician', // 1 gen, 0 FP — Workforce Support Technician (WBD IT; ServiceNow, remote tools, hardware/sw support)
    'bit engineer',                 // 2 gen, 0 FP — Associate BIT Engineer / Multi-Function Engineer (WBD; BIT = Broadcast & IT infrastructure)
    'multi-function engineer',      // 1 gen, 0 FP — Multi-Function Engineer (WBD Remote Operations Center; broadcast IT infrastructure)
    'artist, technical',            // 2 gen, 0 FP — Associate/Advanced Artist, Technical (WBD Games; Unreal Engine, Python/C++, art pipelines)
    'it/ot',                        // 1 gen, 0 FP — IT/OT Technical Analyst (Merck; Information Technology/Operational Technology convergence)
    'training technology digital',  // 1 gen, 0 FP — Training & Technology – Digital Solutions Intern (Bosch; LMS rollout, digital transformation of training programs)
    'navwar assessment',            // 1 gen, 0 FP — NAVWAR Assessment Coordinator (CACI; Naval Warfare Systems Center IT assessment)
    'developer security awareness', // 1 gen, 0 FP — Developer Security Awareness & Engagement Specialist (Vanguard; AppSec awareness programs)
    'associate engineer systems',   // 1 gen, 0 FP — Associate Engineer Systems/Engineer Systems (NG; systems engineering)
    'software cross product',       // 1 gen, 0 FP — Software Cross Product Team Lead – Taiwan Surveillance Radar Program (RTX)
    'technology and data risk',     // 1 gen, 0 FP — Senior Associate, Technology and Data Risk Management (Capital One; TDRM cloud/data technology risk — software domain)
    // TAG-11 C55: CACI software roles
    'it audit specialist',          // 1 gen, 0 FP — IT Audit Specialist (CACI; cybersecurity/FISCAM/application security audit for DHS CBP)
    'systems technical specialist', // 1 gen, 0 FP — Systems Technical Specialist (CACI; IT governance/risk/compliance for DoJ USMS IT modernization)
    // TAG-11 C56: Elanco software roles
    'erp order to cash',            // 1 gen, 0 FP — ERP Order to Cash/GTS Functional Consultant (Elanco; SAP S4/HANA O2C + Global Trade Services)
    // TAG-11 C57: RE/SPEC software roles
    'billing consultant',           // 2 gen, 0 FP — Technical Billing Consultant I/II (RE/SPEC; SaaS billing system implementation/configuration)
    // TAG-PRECISION-13 (B33): IT infrastructure — network/sysadmin/IT PM roles
    'network engineer',             // 113 gen — network engineering (guard: optical/5G/LTE are hardware)
    'systems administrator',        // 77 gen — systems administration (dept rules protect edge cases)
    'system administrator',         // variant form
    'it project manager',           // 15 gen — IT project management (all WD, no dept)
    'linux administrator',          // Linux sysadmin variant
    'storage administrator',        // 2 gen — storage admin
    'osint analyst',                // 6 gen — open source intelligence analysis (defense tech)
    // TAG-PRECISION-13 (B33): internship keyword gaps
    'software development intern',  // 5 gen — software dev internship (not caught by 'software intern')
    'developer intern',             // 2 gen — developer internship
    'intern engineer',              // 2 gen — "Intern Engineer Co-op" (simplify)
    'intern i - software',          // 1 gen — "Intern I - Software Test Development Engineering"
    'algorithm engineer',           // 2 gen — algorithm engineering
    'software architecture',        // 1 gen — "Software Architecture Engineer Intern"
    // TAG-PRECISION-16 (B34): Northrop Grumman inverted title format + Motional AV/robotics
    'embedded software',            // 8 gen — NG "Engineer Embedded Software" + GM test developer
    'engineer software',            // 6 gen — NG inverted "Engineer Software [Quality/Simulation/etc]"
    'motion planning',              // 2 gen — Motional AV motion planning engineers
    'trajectory planning',          // 4 gen — Motional AV trajectory planning engineers
    'ml planner',                   // 1 gen — Motional "Prediction & ML Planner"
    // TAG-PRECISION-17 (B36): keyword gaps from top uninvestigated companies
    'software development',         // 22 gen — SW dev manager/analyst/eng variants at Comcast, NG, Boeing, etc.
    'system software',              // 3 gen — system SW engineering (Google Silicon, Boeing)
    'software reliability',         // 2 gen — SRE variant (Waymo, Google)
    'software safety',              // 1 gen — SW safety engineering (Boeing)
    'software application',         // 3 gen — SW app specialist/manager (Walmart, Microchip)
    'mission software',             // 1 gen — defense SW intern (Palantir)
    'angular developer',            // 2 gen — Angular framework dev
    'salesforce developer',         // 1 gen — SFDC platform dev
    'powerbuilder developer',       // 1 gen — legacy PowerBuilder dev (CACI)
    // TAG-PRECISION-20 (B38): hyphenated variant gaps + cloud platform keywords
    'back-end developer',           // 1 gen, 0 FP — hyphenated variant (BAH)
    'back-end engineer',            // 2 gen, 0 FP — hyphenated variant (guard: isRetailClerk blocks "back-end clerk")
    'full-stack intern',            // 2 gen, 0 FP — hyphenated intern form (Uncountable)
    'aws engineer',                 // 1 gen, 0 FP — AWS platform engineering (CACI)
    'ml ops',                       // 1 gen, 0 FP — space variant of existing 'mlops' (Boston Dynamics)
    'software modernization',       // 1 gen, 0 FP — software modernization engineering (Google Quantum AI)
    // NOTE: 'business systems analyst' NOT added — TAG-PRECISION-8 guard: BSA configures SAP/Workday, not SWE
    // NOTE: 'it support specialist/technician' NOT added — tests confirm IT support is operations, not SWE
    // NOTE: bare 'it support' NOT added — substring of 'audit support' causes 2 FP
    'sharepoint',                   // 2 gen — SharePoint dev/admin (CACI, Guidehouse)
  ];
  const isSalesRole = /\b(sales|account executive|pre-sales|presales)\b/i.test(title);
 // Guard: retail "Back End Clerk" is not a backend engineer (Lowe's — 6 FPs,
  const isRetailClerk = /\b(clerk|stocker|cashier)\b/i.test(title);
 // TAG-MISROUTE-1 Issue 3a: short keywords need word-boundary regex — includes() causes
  // "answer" → "anSWEr", "disrespect" → "diSREspect" false positives (509 + 151 FPs)
  const softwareShortKeywords = /\b(swe|sre)\b/i;
  // 'automation engineer' — HVAC/building/industrial/manufacturing/mechanical automation is hardware, not software
  const isNonSwAutomation = /\b(hvac|building|industrial|process|manufacturing|mechanical)\b/i.test(title);
  // 'security analyst' — physical security roles are not infosec
  const isPhysicalSecurity = /\bphysical\b/i.test(title);
  // 'engineering intern' — mechanical/civil/chemical/electrical interns are hardware; water/mine/rock/geomechanics interns are civil (general)
  // TAG-11 C47: extended to cover RE/SPEC water resources/mine/rock/solid waste interns (civil engineering, not tech)
  const isNonSwEngineeringIntern = /\b(semiconductor|mechanical|civil|chemical|electrical|environmental|water resources|wastewater|mine|rock mechanics|solid waste|cavern|reclamation|geomechanics)\b/i.test(title);
  // TAG-13: 'simulation engineer' — structural/mechanical/thermal simulation is hardware
  const isHwSimulation = /\b(structural|mechanical|thermal|finite element)\b/i.test(title);
  // TAG-11 C47: 'project engineer' — non-software project engineers are not SWE.
  // TAG-KEYWORD-9: expanded to electrical, HVAC, controls, automation, power, weapons, infrastructure.
  // "Controls Project Engineer – HVAC" / "Project Engineer - Power Generation" / "Weapons Infrastructure Project Engineer"
  // are all non-SWE coordination roles. Guard fires when 'project engineer' is sole sw match.
  const isCivilProjectEngineer = /\b(structural|water resources|water treatment|geotechnical|wastewater|mechanical|civil|electrical|hvac|controls|automation|power|generation|weapons|infrastructure|fire protection|commissioning|construction|piping)\b/i.test(title);
  // TAG-18: 'systems engineer' — HVAC controls, physical security, warehouse systems are not software
  const isNonSwSystemsEngineer = /\b(hvac|physical security|warehouse|building controls|facilities)\b/i.test(title);
  // TAG-18: ISSO compliance officers (not engineers) — "information system security officer" is ops/compliance
  const isIssComplianceOfficer = (/\binformation systems? security\b/i.test(title) && /\bofficer\b/i.test(title)) || /\bISSO\b/i.test(title);
  // TAG-PRECISION-5: 'program manager' — bare PM titles (Training PM, People PM, Supply Chain PM) are not SWE.
  // Only classify as software when PM title has tech context (technical, AI, security, etc.).
  // "Technical Program Manager, AI Platform" → software. "Training Program Manager" → not software.
  const isNonTechProgramManager = !/\b(technical|ai |ml |cloud|security|developer|engineering|platform|data |cyber|infra|digital|automation)\b/i.test(title);
  // TAG-PRECISION-8: 'systems analyst' — business/HRIS/financial/people systems are not SWE.
  // "Business Systems Analyst" configures SAP/Workday, not writes code. "AI Systems Analyst" writes code.
  // Guard fires when sole match AND title contains non-SW context.
  const isNonSwSystemsAnalyst = /\b(business systems|hris|workday|people systems|financial systems|finance systems|legal systems|nuclear|logistic|pgim|payroll|investment systems|erp|sap |peoplesoft)\b/i.test(title);
  // TAG-KEYWORD-10: 'servicenow' — ServiceNow admin/analyst/manager/support is not SWE.
  // "ServiceNow Developer" and "ServiceNow Engineer" build software. Everything else configures/administers it.
  // Guard fires when sole match AND title lacks developer/engineer context.
  const isNonSwServiceNow = !/\b(developer|engineer)\b/i.test(title);
  // TAG-PRECISION-13: 'network engineer' — optical/5G/LTE network engineers are hardware/telecom.
  // "Optical Network Engineer" at Google builds physical fiber infrastructure.
  // Guard fires when sole match AND title has hardware context.
  const isHwNetworkEngineer = /\b(optical|5g|lte|fiber|photonics|telecommunications?)\b/i.test(title);
  const matchesSoftware = (text) =>
    softwareKeywords.some(kw => text.includes(kw)) || softwareShortKeywords.test(text);
  // Guard: block guarded keywords only when they are the sole match
  const isGuardedSwOnly = (text) => {
    const matched = softwareKeywords.filter(kw => text.includes(kw));
    if (matched.length !== 1) return false; // multiple matches or short-kw → not solely guarded
    const sole = matched[0];
    if (sole === 'automation engineer' && isNonSwAutomation) return true;
    if (sole === 'security analyst' && isPhysicalSecurity) return true;
    if (sole === 'engineering intern' && isNonSwEngineeringIntern) return true;
    if (sole === 'simulation engineer' && isHwSimulation) return true;
    if (sole === 'project engineer' && isCivilProjectEngineer) return true;
    if (sole === 'systems engineer' && isNonSwSystemsEngineer) return true;
    if (sole === 'program manager' && isNonTechProgramManager) return true;
    if (sole === 'systems analyst' && isNonSwSystemsAnalyst) return true;
    if (sole === 'servicenow' && isNonSwServiceNow) return true;
    if (sole === 'network engineer' && isHwNetworkEngineer) return true;
    return false;
  };
 // TAG-MISROUTE-1 Issue 3b: software domain is now TITLE-ONLY.
  // Description fallback removed — company boilerplate ("full stack technology platform",
  // "alongside our software engineers") caused 1,774 non-tech jobs to be tagged software.
  // Same approach as AI domain (title-only since inception). Keyword list expanded above
  // to compensate for legitimate roles lost.
  // B28: 'site reliability' sole-match on technician titles is not SWE.
  // Jabil "Site Reliability Technician (402)" — facility/equipment tech, not SRE.
  const isSwTechnicianOnly = (() => {
    const matched = softwareKeywords.filter(kw => title.includes(kw));
    if (matched.length !== 1) return false;
    return matched[0] === 'site reliability' &&
      (/\btechnicians?\b/i.test(title) || (/\btech\b/i.test(title) && !/\btechnology\b/i.test(title))) &&
      !/\bengineer/i.test(title);
  })();
  if (!isSalesRole && !isRetailClerk && !isIssComplianceOfficer && !isSwTechnicianOnly && matchesSoftware(title) && !isGuardedSwOnly(title)) {
    pushTag('software', findMatch(softwareKeywords, title) || (softwareShortKeywords.test(title) ? 'swe/sre regex' : null), 'title');
  }

  // AI domain (title-only — prevents description contamination misrouting general jobs)
  // Keywords derived from S78 Auditor sample of 33 intercepted AI-title jobs (all_jobs.json 2026-02-25)
  // TAXONOMY-AUDIT-1: 'llm' and 'nlp' use word-boundary regex — includes() caused
 // "fulfillment" → "fuLLMent" false positive (186 Lowe's jobs tagged AI, finding).
  const aiKeywords = [
    'machine learning', 'computer vision', 'deep learning',
    'applied ai', 'ai engineer', 'ai researcher',
    'natural language processing',
    'large language model', 'generative ai',
    // INTERN-1a Wave 2:
    'ai/ml', 'genai', 'prompt engineer', 'ai tools',
    'artificial intelligence',      // 7 hits — Artificial Intelligence Engineer (Booz Allen, Northrop)
    'ai deployment',                // 21 hits — AI deployment strategist (Mistral AI, Booz Allen)
    'applied researcher',           // 4 gen — applied AI/ML research (Capital One)
    'ai solution developer',        // 1 gen, 0 FP — AI solution development
    'research inference',           // 1 gen, 0 FP — ML inference research
    'loss of control',              // 1 gen, 0 FP — AI safety (loss of control)
    'simulation realism',           // 1 gen, 0 FP — robotics simulation realism
    'frontier biological',          // 1 gen, 0 FP — frontier bio/chem risk research
    'researcher, training',         // 1 gen, 0 FP — ML training researcher
    'researcher, alignment',        // 1 gen, 0 FP — AI alignment researcher
    'researcher, trustworthy',      // 1 gen, 0 FP — trustworthy AI researcher
    'researcher, safety',           // 1 gen, 0 FP — AI safety researcher
    'researcher, interpretability', // 1 gen, 0 FP — interpretability researcher
    'researcher, pretraining',      // 1 gen, 0 FP — pretraining safety researcher
    'vision-language-action',       // 1 gen, 0 FP — Vision-Language-Action Models Intern (Bosch)
    'vision-language-navigation',   // 1 gen, 0 FP — Vision-Language-Navigation ADAS Intern (Bosch)
    'simulation at scale',          // 1 gen, 0 FP — Automated Driving Simulation at Scale RL (Bosch)
    'distributed embodied',         // 1 gen, 0 FP — Distributed Embodied AI Systems Intern (Bosch)
    'multilingual text',            // 1 gen, 0 FP — Technical SETA SME Multilingual Text and Speech (Guidehouse)
    // TAG-PRECISION-13 (B33): AI internship patterns
    'ai intern',                    // 4 gen — AI internship roles
    'ai analyst intern',            // 2 gen — AI analyst internship
    'ai development intern',        // 1 gen — AI development internship
    'agentic ai',                   // 1 gen — Agentic AI roles
    'ai infrastructure',            // 1 gen — AI infrastructure engineering
    'researcher intern',            // 4 gen — ML/AI research internship (simplify: "Researcher Intern - Vision and Graphics")
    // TAG-PRECISION-17 (B36): AI keyword gaps
    'ai developer',                 // 5 gen — AI developer roles (Booz Allen, BAH)
    'mlops',                        // 2 gen — MLOps engineer (Booz Allen)
  ];
  const aiShortKeywords = /\b(llm|nlp)\b/i;
  if (aiKeywords.some(kw => title.includes(kw)) || aiShortKeywords.test(job.title || '')) {
    pushTag('ai', findMatch(aiKeywords, title) || (aiShortKeywords.test(job.title || '') ? 'llm/nlp regex' : null), 'title');
  }

 // Data Science domain (title-only — description fallback removed
  // DESC-MIGRATE-1 moved descriptions to sidecars; all_jobs.json description field is always empty.
  // Description fallback was producing 0 current matches and 1,038 ghost tags.
  const dataScienceKeywords = [
    'data scientist', 'data science', 'data engineer', 'data analyst',
    'machine learning', 'ml engineer', 'ai engineer',
    // INTERN-1a Wave 2:
    'data analytics', 'applied science', 'operations research',
    'algorithm engineering', 'decision science', 'quantitative research',
    'research analyst',
 // FRESHNESS-3: GH general-tagged misclassification fixes (Auditor data audit)
    'research scientist',           // Anthropic, DeepMind — data_science domain (3 confirmed misses)
    'databricks',                   // 4 hits — Databricks engineer/developer (data platform)
    'applied scientist',            // 62 hits — applied science/ML roles
    'intelligence analyst',         // 27 hits — business intelligence + defense intelligence analysts
    'quantum computing',            // 4 gen, 80% spec — quantum computing research/engineering
    'business intelligence',        // 3 gen — BI engineer/analyst (bare form)
    'analytics engineer',           // 6 gen — analytics/data engineering
    'data visualization',           // 5 gen — data visualization analysts
    'bioinformatics',               // 3 gen — bioinformatics specialists
    'data quality',                 // 2 gen — data quality analysts
    'survey analyst',               // 1 gen, 0 FP — survey/employee listening analysis
    'causal inference',             // 1 gen, 0 FP — experimentation/causal inference
    'people analytics',             // 2 gen, 0 FP — people/HR analytics (NBCU)
    'subscriber forecasting',       // 1 gen, 0 FP — subscriber forecasting (NBCU)
    'measurement science',          // 2 gen, 0 FP — measurement science
    'media analytics',              // 1 gen, 0 FP — media analytics
    'power modeling',                // 2 gen, 0 FP — power/energy modeling
    'content analyst',               // 1 gen, 0 FP — content analyst (Bloomberg)
    'content analytics intern',      // 1 gen, 0 FP — content analytics intern (Bloomberg)

    'elint',                        // 1 gen, 0 FP — electronic intelligence analysis
    'signals analyst',              // 1 gen, 0 FP — signals analysis (defense)
    'signals intelligence',         // 1 gen, 0 FP — SIGINT officer
    'fisint',                       // 1 gen, 0 FP — foreign instrumentation signals
    'biometrics analyst',           // 1 gen, 0 FP — biometrics analysis
    'afsim analyst',                // 1 gen, 0 FP — AFSIM modeling/simulation
    'aesthetics analytics',         // 1 gen, 0 FP — AD Aesthetics Analytics (AbbVie commercial analytics)
    'market access contract',       // 1 gen, 0 FP — AD Market Access Contract Analytics (AbbVie)
    'performance lead',             // 1 gen, 0 FP — AD Performance Lead IBD (AbbVie brand analytics)
    'statistician',                 // 2 gen, 0 FP — Statistician Human Subjects Research (Leidos)
    'geo-spatial intelligence',     // 2 gen, 0 FP — Technical SETA SME Geo-Spatial Intelligence (Guidehouse)
    'clinical analytics',           // 1 gen, 0 FP — Healthcare Solution Analyst, Clinical Analytics Solutions (Guidehouse)
    'biostatistician',              // 1 gen, 0 FP — Biostatistician (Abbott)
    'cx data',                      // 1 gen, 0 FP — Analyst, CX Data & Insights (WBD; AI/ML & automation for customer experience)
    'ad sales research',            // 1 gen, 0 FP — Analyst, Ad Sales Research (WBD; audience measurement, attribution analytics)
    'ai solution analyst',          // 1 gen, 0 FP — AI Solution Analyst (FLIR; AI tool evaluation/testing, copilots, RAG systems)
    'atmospheric scientist',         // 1 gen, 0 FP — Atmospheric Scientist (Boeing; weather modeling/atmospheric science for aerospace)
    // TAG-11 C55: CACI data science roles
    'gis analyst',                   // 1 gen, 0 FP — GIS Analyst (CACI; geospatial/geographic information systems analysis)
  ];
  if (dataScienceKeywords.some(kw => title.includes(kw))) {
    pushTag('data_science', findMatch(dataScienceKeywords, title), 'title');
  }

  // Hardware domain
  const hardwareKeywords = [
    'hardware engineer', 'embedded', 'firmware', 'electrical engineer',
    'chip design', 'fpga', 'pcb', 'vlsi', 'robotics', 'mechatronics',
    'avionics', 'mechanical engineer', 'new graduate engineer',
    // Was causing 132 hardware-only misroutes. Manufacturing engineers belong in manufacturing domain.
    // 'manufacturing engineering' (as program/intern title) also moved.
    'materials engineer', 'materials engineering',
    'process engineer', 'process technician',
    'controls engineer', 'controls specialist',
    'hvac technician', 'hvac engineer',
    'industrial automation', 'manufacturing automation', 'building automation', 'process automation',
    // Intern-specific patterns missed by above (INTERN-1 fix):
    'electrical engineering', 'test engineer', 'design engineer',
    'mechanical design', 'hardware design', 'hardware test',
    // INTERN-1a Wave 2:
    'analog', 'mixed-signal', 'ic design', 'dsp', 'power electronics',
    'thermal engineer', 'propulsion', 'turbomachinery', 'fluid component',
    'ground systems', 'radiation effects', 'harness manufacturing',
    'electrical integration', 'cad engineer', 'industrial engineering',
    'quality engineer', 'hardware development engineer', 'electrical design',
    'package engineering', 'signal integrity', 'asic',
    'process integration', 'process safety', 'optical engineer',
    'structural engineer', 'aerospace engineer', 'lidar engineer',
    'physical design', 'plasma etch', 'plasma deposition', 'plasma process', 'reliability engineer', 'equipment engineer',
    'biomedical engineer', 'chemical engineer', 'field applications engineer',
    'application engineer', 'gnc engineer', 'radar engineer',
    'performance engineering', 'wireless system',
    // TAG-OVERHAUL-A additions (verified safe by title + company context):
    'controls integration engineer',  // Amazon DC hardware
    'field service engineer',         // ASML/HP/Caterpillar equipment install
    'verification engineer',          // chip design: logic/timing/functional verification
    'dft engineer',                   // Design-for-Test, semiconductor
    'emulation engineer',             // pre-silicon hardware emulation
    'board validation engineer',      // PCB/hardware bring-up
    'ic verification engineer',       // IC-level verification
    'gpu design verification',        // GPU silicon verification
    'cpu verification',               // CPU silicon verification
 // TAG-CATEGORY-REDESIGN Option 2 (Strategist vocabulary audit — ~71 general+US reclassifications)
    'distribution engineer',              // 15 hits — vehicle/electrical distribution
    'supplier development engineer',      // ~12 hits — electronics/hardware supply chain (SpaceX Starshield, etc.)
    'commissioning engineer',             // 12 hits — equipment bring-up (Amazon DC, data centers)
    'electronics engineer',               // 9 hits — hardware/electronics domain
    'maintenance engineer',               // 7 hits — equipment maintenance (SpaceX/Tesla factory floor)
    'power systems automation engineer',  // 3 hits — electrical grid automation
    'power systems protection engineer',  // 3 hits — electrical grid protection
    'substation protection',              // 3 hits — electrical infrastructure (NOT added: 'substation engineer' bare — too broad)
    'substation control engineer',        // 1 hit — electrical infrastructure
    'photonic packaging engineer',        // 1 hit — semiconductor optics (NOT added: 'packaging engineer' bare — mfg FP risk)
    'field service technician',           // 52 hits — equipment/field service (Leidos, Johnson Controls)
    'service technician',                 // 141 hits — HVAC/fire/equipment service (guard: not customer service)
    'installation technician',            // 13 hits — equipment installation
    'product development engineer',       // 19 hits — hardware R&D (SpaceX, Abbott)
    'field service representative',       // 50 hits — field equipment service reps
    'rf engineer',                        // 15 hits — RF engineering (SpaceX, Leidos, CACI)
    'signal processing',                  // 9 hits — DSP/signal processing engineer
    'operations engineer',                // 57 hits — plant/process operations engineering
    'development engineer',               // 47 hits — R&D/product development engineering
    'industrial engineer',                // 25 hits — industrial/manufacturing engineering
    'test specialist',                    // 22 hits — hardware/equipment test
    'validation engineer',                // 19 hits — hardware/process validation
    'safety engineer',                    // 23 hits — fire/systems/aerospace safety (SOC 17)
    'electrician',                        // 29 hits — maintenance/industrial electricians (SpaceX, utilities)
    'hvac',                               // 37 hits — HVAC technician/programmer/controls (all hardware)
    'cad designer',                       // 5 hits — CAD/civil CAD design roles
    'lab engineer',                       // 4 hits — hardware lab engineers (Amazon, etc.)
    'fire alarm',                         // 1 hit — fire alarm designer/installer
    'fire protection',                    // 1 hit — fire protection EIT
    // 'geologist' removed TAG-11 C47: all hits were RE/SPEC civil/environmental geology (FP) — no tech collateral
    'field engineer',                     // 22 hits — field engineering roles (Johnson Controls, etc.)
    'compliance engineer',                // 8 hits — product/regulatory compliance (legal guard blocks legal tagging)
    'field specialist',                   // 14 hits — field service specialists
    'production engineer',                // 4 hits — production/manufacturing engineering
    'facilities engineer',                // 3 hits — facilities/building engineering
    'applications engineer',              // 3 hits — field applications engineering
    'weld engineer',                      // 3 hits — welding engineering
    'electronic technician',              // 3 hits — electronics bench technicians
    'fire detection',                     // 3 hits — fire detection systems
    'data center operations',             // 3 hits — DC operations technician/engineer
    'diagnostic technician',              // 4 gen — diagnostic/test technicians (Jabil)
    'electrical installer',               // 3 gen — electrical installation (JCI)
    'biomedical equipment',               // 5 gen — biomedical equipment technicians
    'design release engineer',            // 5 gen — design release engineering (GM)
    'product review engineer',            // 3 gen — product review/liaison engineering
    'analysis engineer',                  // 12 gen — structural/thermal analysis engineering
    'naval architect',                    // 1 gen — naval architecture/marine design
    'production pilot',                   // 1 gen — production test pilots
    'radar operator',                     // 1 gen — radar test operations
    'piping design',                      // 2 gen — piping/process design
    'test planner',                       // 1 gen — test planning engineering
    'fire installer',                     // 3 gen — fire system installers
    'energy analyst',                     // 2 gen — energy systems analysis
    'nuclear',                            // 2 gen — nuclear engineering
    'journeyman',                         // 3 gen — journeyman tradespeople
    'automated logic',                    // 7 gen — building automation (Johnson Controls)
    'wireless engineer',                  // 3 gen — wireless/RF engineering
    'laser',                              // 1 gen — laser technician/engineer
    'servo',                              // 1 gen — servo control engineering
    'hydrodynamic',                       // 1 gen — hydrodynamic engineering
    'material scientist',                 // 1 gen — materials science
    'hardware technician',                // 3 gen — hardware bench technicians
    'rf communications',                  // 1 gen — RF communications engineering
    'design for test',                    // 1 gen — DFT engineering
    'electronics technician',             // 8 gen — plural form (had 'electronic technician')
    'solder technician',                  // 4 gen — soldering technicians
    'physicist',                          // 3 gen — physics/applied physics
    'circuit design',                     // 2 gen — circuit design (was desc phrase only)
    'fire sprinkler',                     // 3 gen — fire sprinkler installers
    'electrical eit',                     // 1 gen — electrical EIT roles
    'sheet metal technician',             // 2 gen — sheet metal work
    'calibration',                        // 9 gen — calibration technicians/engineers
    'powertrain',                         // 4 gen — powertrain engineering
    'thin films',                         // 2 gen — thin film technicians
    'environmental scientist',            // 2 gen — environmental science
    'solar technician',                   // 1 gen — solar panel technicians
    'electrical technician',              // 4 gen — electrical techs (different from electronic)
    'frac technician',                    // 1 gen — hydraulic fracturing
    'power engineer',                     // 4 gen — power systems engineering (SEL)
    'transmission line',                  // 1 gen — transmission line engineering (SEL)
    'r&d engineer',                       // 17 gen, 100% spec — R&D engineering
    'service engineer',                   // 13 gen, 98% spec — field/service engineering
    'systems technician',                 // 11 gen, 75% spec — systems/electronics tech
    'controls systems',                   // 9 gen, 85% spec — controls/automation
    'engineering tech',                   // 6 gen, 80% spec — engineering technician (short form)
    // 'structural bim' removed TAG-11 C47: all 5 hits were RE/SPEC civil structural BIM technicians (FP) — no tech collateral
    'performance engineer',               // 4 gen — perf/thermal/systems engineering
    'upgrade install',                    // 5 gen — installation/relocation engineering
    'motorsports tire',                   // 2 gen, 0 FP — motorsports tire engineering (Oshkosh)
    'heavy duty ev',                      // 1 gen, 0 FP — heavy-duty EV technician (Oshkosh)
    'microelectronics sme',               // 1 gen, 0 FP — radiation hardened microelectronics
    'combat systems integration',         // 1 gen, 0 FP — naval combat systems
    'radar modeling',                     // 1 gen, 0 FP — radar modeling engineer
    'substation engineer',                // 1 gen, 0 FP — electrical substation engineer
  
    'metallurgical engineer',             // 2 gen, 0 FP — metallurgical engineering
    'platform cots',                      // 1 gen, 0 FP — COTS platform engineering
    'mrb engineer',                       // 1 gen, 0 FP — material review board engineering
    'nssms technician',                   // 1 gen, 0 FP — NATO SEASPARROW technician
    'field service supervisor',           // 1 gen, 0 FP — field service supervision
    'radar sme',                          // 1 gen, 0 FP — radar subject matter expert
    '3d reconstruction',                  // 1 gen, 0 FP — 3D reconstruction
    'digital modeling',                   // 1 gen, 0 FP — digital modeling engineer
    'lidar intern',                       // 1 gen, 0 FP — lidar internship
    'protected satcom',                   // 1 gen, 0 FP — protected SATCOM
    'pressure systems',                   // 1 gen, 0 FP — pressure systems specialist
    'hydrogen electrolyzer',                // 1 gen, 0 FP — H2 electrolyzer simulation (Bosch)
    'biosensor intern',                     // 1 gen, 0 FP — biosensor internship (Bosch)
    'laboratory engineer',                  // 1 gen, 0 FP — laboratory engineering (Bosch)
    'media replay',                         // 2 gen, 0 FP — media replay operator (Disney)
    'motorsports aero',                     // 1 gen, 0 FP — motorsports aero data (GM)
    'motorsports vehicle dynamics',         // 1 gen, 0 FP — motorsports dynamics (GM)
    'ress process',                         // 2 gen, 0 FP — RESS process HV tech (GM)
    'creative seat designer',               // 1 gen, 0 FP — seat design (GM)
    'loads and dynamics',                   // 2 gen, 0 FP — loads/dynamics engineer (SpaceX)
    'recovery engineer',                    // 1 gen, 0 FP — recovery engineer (SpaceX)
    'mechanisms engineer',                  // 1 gen, 0 FP — mechanisms engineer (SpaceX)

    'chiller system',                     // 1 gen, 0 FP — chiller system technician
    'shoulder r&d',                       // 1 gen, 0 FP — shoulder R&D (J&J)
    'mechanical simulation',              // 3 gen, 0 FP — mechanical simulation (WD)
    'sot reader',                         // 1 gen, 0 FP — SOT reader film research (WD)
    'hdd testing',                        // 1 gen, 0 FP — HDD testing (WD)
    'cmf designer',                       // 1 gen, 0 FP — CMF designer (Polaris)
    // 'field technician- water' removed TAG-11 C47: sole hit was RE/SPEC water resources field tech (FP) — no tech collateral
    'land development',                   // 4 gen, 0 FP — land development (RE/SPEC)
    'engine systems integration',         // 1 gen, 0 FP — engine systems integration
    'robot optics',                       // 1 gen, 0 FP — robot optics (Neuralink)
    'neuroengineer',                      // 1 gen, 0 FP — neuroengineering (Neuralink)
    'engineer structural',                // 1 gen, 0 FP — structural engineering (Northrop)
    'permeability modifier',              // 1 gen, 0 FP — permeability modifier (Baker Hughes)
    'battery responsible engineer',       // 1 gen, 0 FP — battery responsible eng (Blue Origin)
    'av associate',                       // 1 gen, 0 FP — AV associate (Braze)
    'yield enhancement',                  // 1 gen, 0 FP — yield enhancement engineer (Micron)
    'healthcare spatial designer',        // 1 gen, 0 FP — healthcare spatial design (Philips)
    'drafter/ designer',                  // 1 gen, 0 FP — drafter/designer (SEL)
    'membrane r&d',                       // 1 gen, 0 FP — membrane R&D (Veolia)
    'cad technical designer',             // 1 gen, 0 FP — CAD technical designer (Blue Origin)
    'phase integrator',                   // 1 gen, 0 FP — phase integrator (Blue Origin)
    'materials and process',               // 2 gen, 0 FP — M&P engineer (Blue Origin)
    'implant account',                    // 1 gen, 0 FP — implant account technologist
    'architecture intern',                // 1 gen, 0 FP — chip architecture internship
    'cca design',                         // 1 gen, 0 FP — Digital CCA Design (circuit card assembly)
    'flight line',                        // 2 gen, 0 FP — F-15 Flight Line Technician (Boeing)
    'ordnance technician',                // 1 gen, 0 FP — F/A-18 Ordnance Technician (Boeing)
    'sustainment engineer',               // 1 gen, 0 FP — F-15EX/IA Sustainment Engineer (Boeing)
    'retrofit technical',                 // 1 gen, 0 FP — Retrofit Technical Specialist (Boeing)
    'mp&p engineer',                      // 1 gen, 0 real FP — MP&P = Materials Processes Physics
    'airworthiness',                      // 1 gen, 0 real FP — Airworthiness Support (pre-existing legal FP)
    'guidance navigation & control',      // 1 gen, 0 FP — GNC Engineer (avoids Anduril software FP)
    'system health engineer',             // 1 gen, 0 FP — Reliability & System Health Engineer (Boeing)
    'mass properties engineer',           // 1 gen, 0 FP — Weights & Mass Properties Engineer (Boeing)
    'training device technician',         // 1 gen, 0 FP — Training Device Technician Flight Sim (Boeing)
    'tech pubs',                          // 1 gen, 0 FP — Chinook Tech Pubs Author (Boeing)
    'ltamds',                             // 1 gen, 0 FP — LTAMDS Program Integrator (RTX)
    'slcm-n',                             // 1 gen, 0 FP — SLCM-N Program Integrator (RTX)
    'coyote block',                       // 1 gen, 0 FP — Coyote Block 3 Chief Engineer (RTX)
    'patriot missile',                    // 1 gen, 0 FP — Technical Aide Patriot Missile (RTX)
    'javelin joint venture',              // 1 gen, 0 FP — Javelin JV Portfolio Chief Engineer (RTX)
    'f135 fse',                           // 1 gen, 0 FP — F135 FSE Cherry Point (RTX)
    'hydrogen technology',                // 1 gen, 0 FP — Hydrogen Technology Co-op (Bosch)
    'vision system engineer',             // 1 gen, 0 FP — Vision System Engineer AOI (Bosch)
    'computational materials science',    // 1 gen, 0 FP — Computational Materials Science Intern (Bosch)
    'plc controls technician',            // 1 gen, 0 FP — PLC Controls Technician Siemens (Bosch)
    'rf seeker',                          // 1 gen, 0 FP — RF Seeker Engineer (Leidos)
    '3d substation',                      // 1 gen, 0 FP — 3D Substation Designer (Leidos)
    'electronic warfare',                 // 3 gen, 1 acceptable — EW Analyst (Leidos), FUSION CUAS Analyst (Leidos), Air Defense EW Analyst (CACI). 1 FP: Motorola EW Sales Eng = correctly hardware-adjacent
    'missile launcher',                   // 1 gen, 0 FP — Missile Launcher Product Team Lead (Leidos)
    'loads & dynamics',                   // 1 gen, 0 FP — Loads & Dynamics Engineer Starship (SpaceX)
    'guidance navigation control',        // 2 gen, 0 FP — Guidance Navigation Control Engineer L2/3, L4 (Northrop Grumman)
    'nre operator',                       // 1 gen, 0 FP — NRE Operator (Northrop Grumman) [Non-Recurring Engineering]
    'causal technical',                   // 1 gen, 0 FP — Causal Technical Professional (Northrop Grumman)
    // C58: defense/hardware keyword gaps
    'controls system',            // 2 gen — controls system design (e.g. "Controls System Designer")
    'radio frequency engineer',   // 1 gen — RF engineering
    'sensors engineer',           // 1 gen — sensor systems engineering
    'espasat',                            // 1 gen, 0 FP — ESPASat Product Line Program Coordinator (Northrop Grumman)
    'u105 sensors',                       // 1 gen, 0 FP — U105 SENSORS&SYSTEMS TECH (Northrop Grumman)
    'electronic ground support',          // 1 gen, 0 FP — Electronic Ground Support Equipment (EGSE) Engineer (Northrop Grumman)
    'condition monitoring advisor',       // 1 gen, 0 FP — Condition Monitoring Advisor - Reliability (Caterpillar) [predictive maintenance engineering]
    'cat technology component',           // 1 gen, 0 FP — CAT Technology Component Coordinator (Caterpillar) [Career Area: Engineering — machine/vehicle hardware]
    'regulatory compliance technology specialist', // 1 gen, 0 FP — Technical Regulatory Compliance Technology Specialist - Electrical/Electronics (Caterpillar) [Career Area: Engineering]
    'autonomy project team lead',         // 1 gen, 1 justified FP — Autonomy Project Team Lead (Caterpillar x2); FP is same company misclassified as operations; desc confirms hardware/NTI engineering
    'electrical diagnostician',     // 1 gen, 0 FP — Launch Electrical Diagnostician (General Motors) [vehicle electrical systems]
    'thermal 1d',                   // 2 gen, 0 FP — Thermal 1D VDDV Engineer (General Motors x2) [1D thermal simulation engineering]
    'vehicle fastening',            // 1 gen, 0 FP — VDDV Global Technical Specialist Vehicle Fastening (General Motors)
    'wheel designer',               // 1 gen, 0 FP — Entry-Level Wheel Designer (General Motors) [vehicle component design engineering]
    'cooling pump',                 // 1 gen, 0 FP — Technical Specialist Cooling Pump System and Hardware (General Motors)
    'structures/durability',        // 1 gen, 0 FP — Technical Specialist Structures/Durability (General Motors) [vehicle structural engineering]
    'paint and polymer',            // 1 gen, 0 FP — Researcher Paint and Polymer Technology (General Motors) [materials engineering]
    'test cell support',            // 1 gen, 0 FP — Onsite & Test Cell Support Technician (General Motors) [engine/powertrain test cell]
    'product validation owner',     // 1 gen, 0 FP — Product Validation Owner GPSSC (General Motors)
    'cfd simulation',               // 1 gen, 0 FP — 3D-CFD Simulation Intern (Bosch; 3D CFD/thermal simulation of engine components)
    'reliability, availability, maintainability', // 1 gen, 0 FP — Engineer Level I – Reliability, Availability, Maintainability (RAM) Analysis (CACI; systems reliability engineering for defense systems)
    'vision imaging',            // 1 gen, 0 FP — Vision Imaging Engineer (Intuitive; imaging algorithms, camera/optics for da Vinci robot)
    'associate engineer electronics', // 1 gen, 0 FP — Associate Engineer Electronics (NG; electronics engineering)
    'associate engineer electrical',  // 1 gen, 0 FP — Associate Engineer Electrical/Engineer Electrical Level 1/2 (NG; electrical engineering)
    'environmental effects engineering', // 1 gen, 0 FP — AD Environmental Effects Engineering Strategy & Integration Lead (RTX; environmental hardening for defense systems)
    'structural repair',             // 1 gen, 0 FP — Structural Repair Engineer (Boeing; aircraft structural repair/MRO engineering)
    'electrical retrofit',           // 1 gen, 0 FP — Electrical Retrofit Engineer (Boeing; avionics/electrical systems service bulletin retrofit)
    'lab test program',              // 1 gen, 0 FP — Lab Test Program Integrator (Boeing; BT&E lab test integration for defense programs)
    'technical designer',            // 1 gen, 0 FP — Technical Designer (Interiors) (Boeing; cabin interiors CAD/design for 787 program)
    // TAG-26: SpaceX Starlink/Starshield semiconductor + RF hardware
    'device physics',                   // 1 gen, 0 FP — Device Physics Engineer (SpaceX Starlink)
    'hardware reliability',             // 14 matches, 0 FP — all hardware reliability engineering
    'scada',                            // 4 matches, 0 real FP — SCADA systems engineering (1 manufacturing, acceptable)
    'ic package',                       // 1 gen, 0 FP — IC Package Engineer (SpaceX Starlink)
    'eee components',                   // 1 gen, 0 FP — EEE Components Engineer (SpaceX)
    'eee failure',                      // 1 gen, 0 FP — EEE Failure Analysis Technician (SpaceX)
    'electromagnetic effects',          // 4 matches, 0 real FP — EM effects engineering (2 Boeing general that should be HW)
    'electro-optical',                  // 2 matches, 0 FP — electro-optical engineering
    'launch engineer',                  // 4 matches, 0 real FP — launch engineering (SpaceX)
    'rfic engineer',                    // compound: avoids 'superficial' substring FP
    'microwave engineer',               // 3 matches, 1 marginal (Starlink Mobile tagged SW by pipeline)
    // TAG-11 C55: CACI hardware roles
    'condition based maintenance',   // 1 gen, 0 FP — Engineer - Condition Based Maintenance (CACI; predictive/condition-based maintenance engineering for defense systems)
    // TAG-11 C56: Elanco hardware roles
    'process team engineer',         // 1 gen, 0 FP — Associate, Process Team Engineer (Elanco; process engineering for pharma/animal health manufacturing)
    // TAG-PRECISION-17 (B36): hardware keyword gaps
    'ndt technician',               // 5 gen — nondestructive testing (Boeing, NG)
    'fluid system',                 // 1 gen — fluid systems engineering (Blue Origin)
    // TAG-PRECISION-19 (B37): hardware keyword gaps
    'component engineer',           // 8 gen — semiconductor/electronics component engineering
  ];
  // ENR-8: Intuitive Surgical clinical/QC FP detection (declared here — used in both
  // hardware guard below and pre-O*NET guard above line ~2640).
  const isIntuitive = /intuitive surgical|intuitive/i.test(job.company_name || '');
  const isIntuitiveClinicalFP = isIntuitive && (
    /\bclinical applications? engineer\b/i.test(title) ||
    /\bquality inspection failure analysis\b/i.test(title)
  );

  // Guard: 'service technician' — sole-match is ALWAYS a FP (TAG-PRECISION-7)
  // All 63 sole-match service technicians are service/repair/maintenance (Comcast, JC, Lucid, etc.)
  // When title also matches another HW keyword (circuit, RF, embedded, etc.) → legitimate HW
  const matchesHardware = hardwareKeywords.some(kw => title.includes(kw));
  if (matchesHardware) {
    const isOnlyServiceTech = title.includes('service technician') &&
      !hardwareKeywords.some(kw => kw !== 'service technician' && title.includes(kw));
    // TAG-13: 'operations engineer' in cloud/devops/SRE context is software, not hardware
    const isCloudOpsEng = title.includes('operations engineer') &&
      /\b(cloud|devops|site reliability|platform)\b/i.test(title) &&
      !hardwareKeywords.some(kw => kw !== 'operations engineer' && title.includes(kw));
    // operations technicians, not hardware engineers. Veolia water treatment FSRs (PLC,
    // water treatment, mobile water commissioning) are field ops, not hardware engineering.
    // Non-Veolia FSRs (RTX NASAMS, Boeing F-22/F-18, Motorola, INFICON, Leidos) are
    // defense/comms/instrumentation hardware — correctly kept.
    const isWaterUtilityFSR = title.includes('field service representative') &&
      /water treatment|water technolog|water commissioning|plc technician/i.test(title) &&
      !hardwareKeywords.some(kw => kw !== 'field service representative' && title.includes(kw));
    // ENR-7: Veolia Chemical/O&G/Energy field-ops guard (slug-specific).
    // Veolia Chemical Solutions, O&G down-hole, Energy Systems, and I&E technicians
    // are field operations roles, not hardware engineering. Matched via field-service/trades
    // keywords but produce zero skills — Philips/ASML have legitimate hardware FSEs and
 // must NOT be guarded globally. Baker Hughes guarded separatelyA — oilfield, not tech).
    // Veolia legitimate hardware (commissioning engineers, data center electrical/mechanical
    // engineers) match via 'commissioning engineer'/'electrical engineer'/'mechanical
    // engineer'/'mechanical design' — unaffected by this guard.
    const isVeolia = /veolia/i.test(job.company_name || '');
    const veoliaFieldOpsKeywords = [
      'field service representative', 'field service technician',
      'service technician', 'systems technician',
      'electrician', 'electrical technician', 'journeyman',
    ];
    const isVeoliaFieldOps = isVeolia &&
      veoliaFieldOpsKeywords.some(kw => title.includes(kw)) &&
      !hardwareKeywords.some(kw => !veoliaFieldOpsKeywords.includes(kw) && title.includes(kw));
 //A: NCR Voyix field service technicians repair ATMs/POS terminals — operations,
    // not hardware. 4 misrouted jobs visible in consumer repos. NCR has no legitimate
    // hardware roles; all their tech roles are software (tagged via software keywords).
    const isNCR = /ncr voyix|ncr/i.test(job.company_name || '');
    const ncrFieldOpsKeywords = [
      'field service technician', 'service technician',
      'field service representative',
    ];
    const isNCRFieldOps = isNCR &&
      ncrFieldOpsKeywords.some(kw => title.includes(kw)) &&
      !hardwareKeywords.some(kw => !ncrFieldOpsKeywords.includes(kw) && title.includes(kw));
 //A: Baker Hughes field service/maintenance roles are oilfield industrial — not tech
    // hardware. "Nuclear mechanical engineer", "Machine Maintenance Technician", "Field
    // Specialist" are drilling/turbine maintenance. Baker Hughes legitimate tech roles
    // ("AI Solutioning Consultant") match via software/AI keywords, unaffected by this guard.
    const isBakerHughes = /baker hughes/i.test(job.company_name || '');
    const bakerFieldOpsKeywords = [
      'field service engineer', 'field service technician',
      'field specialist', 'service technician',
      'machine maintenance', 'maintenance technician',
    ];
    const isBakerFieldOps = isBakerHughes &&
      bakerFieldOpsKeywords.some(kw => title.includes(kw)) &&
      !hardwareKeywords.some(kw => !bakerFieldOpsKeywords.includes(kw) && title.includes(kw));
 //A: Trades keyword guard — hvac, electrician, maintenance technician, journeyman,
    // apprentice are trades roles when they're the SOLE hardware keyword match.
    // Legitimate tech-hardware cases have additional context: "HVAC Controls Engineer"
    // matches both hvac + controls engineer, "Wafer Equipment Maintenance Technician"
    // matches both maintenance technician + wafer. Sole-match = no tech context = trades.
    // Fixes 15 visible misroutes in hardware repo (HVAC techs, automotive electricians,
    // aircraft maintenance, seal repair) without affecting defense/semiconductor roles.
    const tradesKeywords = [
      'hvac', 'hvac technician', 'hvac engineer',
      'electrician', 'electrical technician', 'journeyman',
      'maintenance technician', 'maintenance tech', 'maintenance mechanic',
      'maintenance operator', 'maintenance supervisor',
      'apprentice',
    ];
    const isTradesOnly = (() => {
      const hwMatches = hardwareKeywords.filter(kw => title.includes(kw));
      if (hwMatches.length === 0) return false;
      // If ALL hardware matches are trades keywords → no tech-hardware context → block
      // If ANY match is non-trades (controls engineer, wafer, embedded, etc.) → keep
      return hwMatches.every(kw => tradesKeywords.includes(kw));
    })();
    // TAG-22: Software-primary guard — titles with "software" as a primary descriptor
    // are software roles, not hardware. Blocks HW tag for "Software Test Engineer" etc.
    // Exception: "Hardware/Software Co-Design" and "Hardware Design ..., Software Defined Radio"
    // where "software" is in an org/product name, not the primary role.
    const isSoftwarePrimaryRole = title.includes('software') &&
      !/hardware\s*\/\s*software|hardware\s*and\s+software/i.test(title) &&
      !/^hardware\s+(design|test|engineer|development|validation)/i.test(title);
    // TAG-GUARD-1: Supply chain engineering FP guard. "Process Engineer - Supply Chain",
    // "Quality Engineer - Supply Chain", "Sourcing Engineer", "Industrial Engineer" in
    // supply chain/warehouse/procurement context are operations/logistics roles, not hardware.
    // These engineer-titled jobs match hardwareKeywords but the actual work is supply chain ops.
    const supplyChainKeywords = ['supply chain', 'procurement', 'sourcing', 'buyer', 'warehouse', 'shipping', 'receiving', 'inventory'];
    const supplyChainEngineeringKws = ['process engineer', 'quality engineer', 'industrial engineer', 'production engineer', 'sourcing engineer', 'supplier development engineer', 'procurement engineer', 'cost value engineer', 'materials associate', 'production scheduler'];
    const isSupplyChainEng = supplyChainKeywords.some(kw => title.includes(kw)) &&
      hardwareKeywords.filter(kw => title.includes(kw)).every(kw => supplyChainEngineeringKws.includes(kw));
    // TAG-PRECISION-11: Technician-only guard — "Technician" is a support/maintenance role, not
    // hardware engineering. When the title's primary role is "technician" (no "engineer"/"scientist"
    // context), skip HW tag. 39 visible FPs in HW consumer repo (service techs, quality control
    // techs, installation techs, field service techs). Zero FN risk: no HW engineering role is
    // titled solely "Technician" without "Engineer" also appearing.
    const isTechnicianOnly = (() => {
      const hasTechRole = /\btechnicians?\b/i.test(title) || (/\btech\b/i.test(title) && !/\btechnology\b/i.test(title));
      if (!hasTechRole) return false;
      // "Engineering Technician", "Quality Engineering Technician" etc. — borderline but keep
      // to avoid FN on engineering-support roles at defense/semiconductor companies
      const hasEngContext = /\bengineer/i.test(title) || /\bscientist\b/i.test(title) ||
        /\bphysicist\b/i.test(title) || /\barchitect\b/i.test(title);
      if (hasEngContext) return false;
      // TAG-PRECISION-17: Some hardware keywords explicitly identify technician roles that ARE hardware
      // (e.g., "electronics technician", "ndt technician"). Don't guard these — they're intentional matches.
      // NOTE: Only "electronics technician" (with 's') — "electronic technician" (singular) is blocked
      // per PRECISION-11 (bare Electronic Technician is ops, not HW engineering).
      // NOTE: "field service technician" is NOT included — PRECISION-11 established field service is ops.
      // NOTE: "test technician" is NOT included — "Propulsion Test Technician" and "Hardware Test Technician"
      // are blocked per PRECISION-11 (technician-only roles without engineering context).
      const hwTechnicianKeywords = [
        'electronics technician', 'ndt technician', 'rf technician',
        'hvac technician', 'hvac/r technician',
      ];
      if (hwTechnicianKeywords.some(kw => title.includes(kw))) return false;
      return true;
    })();
    // B28: 'embedded' sole-match on sales/finance/consultant titles is not hardware.
    // "Embedded Sales Development Representative" (Workato), "Implementation Consultant, Embedded Finance" (Brex)
    // are business roles using "embedded" as a product/finance term, not embedded systems engineering.
    const hwMatches = hardwareKeywords.filter(kw => title.includes(kw));
    const isEmbeddedNonTech = hwMatches.length === 1 && hwMatches[0] === 'embedded' &&
      /\b(sales|finance|consultant|account|representative|manager)\b/i.test(title) &&
      !/\bengineer/i.test(title);
    // B28: 'automated logic' sole-match on sales titles is not hardware.
    // Carrier Global "Service Sales Representative, Automated Logic" — Automated Logic is a
    // Carrier subsidiary (building automation), not a hardware engineering role.
    const isAutomatedLogicSales = hwMatches.length === 1 && hwMatches[0] === 'automated logic' &&
      /\b(sales|representative|manager)\b/i.test(title) &&
      !/\bengineer/i.test(title);
    if (!isOnlyServiceTech && !isCloudOpsEng && !isWaterUtilityFSR && !isVeoliaFieldOps && !isIntuitiveClinicalFP && !isNCRFieldOps && !isBakerFieldOps && !isTradesOnly && !isSoftwarePrimaryRole && !isSupplyChainEng && !isTechnicianOnly && !isEmbeddedNonTech && !isAutomatedLogicSales) {
      pushTag('hardware', findMatch(hardwareKeywords, title), 'title');
    }
  }

  // Healthcare domain (title-only — short credentials use word-boundary regex)
  // Previously named 'nursing' — renamed TAG-OVERHAUL-B to reflect actual coverage (PT, pharmacist, etc.)
  const healthcareExact = [
    'registered nurse', 'nurse practitioner', 'nursing', 'travel nurse', 'lvn', 'graduate nurse',
    'licensed practical nurse', 'licensed vocational nurse',
    'patient care technician', 'patient care tech',
    'surgical technician', 'surgical tech',
    'pharmacy technician', 'pharmacy tech',
    'physical therapist', 'occupational therapist',
    'rehab aide', 'rehabilitation aide',
    'medical lab scientist', 'medical laboratory scientist',
    'dialysis technician', 'dialysis tech',
    'emergency department technician', 'emergency dept technician',
    'respiratory therapist',
    'medical assistant',
    'phlebotomist',
    'radiology technologist', 'radiologic technologist',
    'sonographer', 'ultrasound technologist',
    'pharmacist',
    'dietitian',
    'sterile processing technician',
    'speech therapist', 'speech language pathologist',
    'ct technologist', 'computed tomography technologist',
    'mammography technologist',
    'polysomnographic technician', 'sleep technician', 'sleep tech',
    'cytogenetics technologist', 'cytogenetic technologist',
    'pathologist assistant',
    'paramedic',
    'patient access representative',
    'ambulatory surgery assistant',
    'unit service associate',
    'clinic assistant', 'practice assistant',
    'neonatal transport',
    // TAG-OVERHAUL-B additions (492 additional clinical jobs in 'general'):
    'anesthetist', 'anesthesia technician',
    'mri technologist', 'echocardiography technologist', 'echo technician',
    'ekg technician', 'ekg tech',
    'radiation therapist',
    'endoscopy technician',
    'clinical research coordinator',
    'patient service representative', 'patient service specialist',
    'patient access rep',
    'patient transporter',
    'medical office specialist',
    'lab support technician', 'laboratory assistant',
    'behavioral health',
    'histotechnologist',
    'prior authorization specialist',
    'child life specialist',
    'exercise physiologist',
    'medical technologist',
    'medical interpreter',
 // GENERAL-CLASSIFICATION additions — +376 verified from live pool):
    'physician',                // PRN Emergency Medicine Physician, Faculty Physician
    'pharmacy intern',          // pharmacy intern roles not caught by 'pharmacy tech' / 'pharmacist'
    'pharmacy manager',         // pharmacy operations management (Walmart/Sam's, 37 gen)
    'pharmacy pre-grad',        // pharmacy pre-graduate intern (Walmart, 37 gen)
    'pharmacy grad intern',     // pharmacy graduate intern (Walmart/Sam's, 19 gen)
    'grad intern (hourly)',     // pharmacy grad intern variant (Sam's Club Pharmacy, 2 gen)
    'optician',                 // optical dispensing (Walmart/Sam's, 18 gen)
    'optometrist',              // eye care professional (Walmart/Sam's, 10 gen)
    'clinical technician',      // clinical lab/hospital techs
    'clinical specialist',      // clinical device/product specialists
    'clinical associate',       // clinical support roles
    'medical screener',         // intake/screening roles
    'medical scribe',           // documentation support
    'radiology tech',           // shorthand caught by 'radiology technologist' longer form too
    'dental assistant',         // dental clinic support
    'dental hygienist',         // dental clinical
    'veterinary',               // vet tech, veterinary assistant
    'ophthalmic',               // ophthalmic tech, ophthalmic assistant
    'cardiac tech',             // cardiac monitoring/telemetry
    'health educator',          // public health education roles
    'public health',            // public health analyst/coordinator
    'plasma center technician',     // 35 hits — Takeda/BioLife plasma donation techs
    'laboratory technician',        // 18 hits — clinical/hospital lab techs
    'lab technician',               // 18 hits — shortened form
    'oncology',                     // 54 hits — oncology specialist/rep (medical device/pharma)
    'clinical territory',           // 17 hits — clinical territory associate/manager (medical device)
    'spine specialist',             // 25 hits — associate spine specialist (Medtronic/Stryker)
    'interventional specialist',    // 14 hits — interventional cardiology/radiology (Medtronic)
    'phlebotom',                    // 16 hits — phlebotomist/phlebotomy (prefix match)
    'cardiovascular',               // 30 hits — cardiovascular nurse/consultant/hospitalist (AbbVie, Medtronic)
    'endoluminal',                  // 6 hits — endoluminal territory associate (medical device)
    'health services',              // 7 hits — health services coding/admin
    'patient account',              // 19 hits — patient account representative (hospital billing)
    'clinical psychologist',        // 3 hits — clinical psych roles (defense/VA)
    'surgical consultant',          // 7 hits — medical device surgical consulting
    'clinical account',             // 18 hits — clinical account specialist (med device/pharma)
    'neurophysiologist',            // 25 hits — neuromonitoring roles
    'psychiatrist',                 // 9 hits — psychiatrist roles (Talkiatry, defense/VA)
    'counselor',                    // 9 hits — military family life counselors, mental health counselors
    'veterinarian',                 // 3 hits — professional services veterinarians
    'microbiologist',               // 1 hit — microbiology/sterilization roles
    // TAG-PRECISION-10: 'chemist' removed — causes 5+ FPs (SpaceX PCB, NG defense, Benchling SW,
    // Handshake edtech, NVIDIA semiconductor). Word matches 'chemistry' via substring.
    // Abbott (3 genuine pharma chemists) still visible in NGJ main repo via other HC keywords.
    // Re-add with per-company override if that pattern is built (TENANT_DEFAULTS v2).
    'research associate',           // 15 gen, 89% spec — clinical/medical research associates
 // 'mental health' moved to regex guard below — 'environmental' contains 'mental' substring (TAG-13)
    'medical laboratory',           // 6 gen, 100% spec — medical lab technologists
    'clinical quality',             // 4 gen — clinical quality assurance
    'clinical trial',               // 4 gen — clinical trial statistics/management
    'associate scientist',          // 9 gen — biotech/pharma research scientists
    'medical coding',               // 1 gen — medical coding/billing
    'lab analyst',                  // 2 gen — laboratory analysts
    'clinical integration',         // 2 gen — clinical integration team leads
    'formulation scientist',        // 3 gen — pharmaceutical formulation
    'clinical consultant',          // 4 gen — clinical consulting roles
    'dental',                       // 3 gen — dental field roles (bare form)
    'medical biller',               // 3 gen — medical billing
    'proteomics',                   // 1 gen — proteomics research
    'clinical lab',                 // 4 gen, 2 FP — clinical laboratory roles
    'inpatient coding',             // 1 gen, 0 FP — medical coding
    'patient access',               // 1 gen, 0 FP — patient registration/access
    'industrial hygiene',           // 1 gen, 0 FP — industrial hygiene technician
    'him coding',                   // 1 gen, 0 FP — health info management coding
    'payer enrollment',             // 1 gen, 0 FP — healthcare payer enrollment
    'release of information',       // 1 gen, 0 FP — medical records release
    'admitting representative',     // 3 gen, 0 FP — hospital admitting
    'patient relations',            // 1 gen, 0 FP — patient relations
    'clinical documentation improvement', // 1 gen, 0 FP — CDI specialist
    'credit balance specialist',    // 1 gen, 0 FP — healthcare credit balance
    'cash poster',                  // 1 gen, 0 FP — healthcare payment posting
    'birth clerk',                  // 1 gen, 0 FP — birth records clerk
    'electron microscopy',          // 1 gen, 0 FP — EM laboratory
  
    'licensed psychologist',         // 1 gen, 0 FP — licensed psychologist
    'immunologist',                  // 1 gen, 0 FP — immunology
    'strength and conditioning',     // 1 gen, 0 FP — S&C specialist
    'molecular geneticist',          // 1 gen, 0 FP — molecular geneticist
    'pharmacovigilance',             // 1 gen, 0 FP — pharmacovigilance scientist
    'regulatory cmc',                // 1 gen, 0 FP — regulatory CMC lead
    'lab technologist',              // 1 gen, 0 FP — laboratory technologist (Moog)
    'msl head',                      // 1 gen, 0 FP — MSL head (J&J)
    'hcp engagements',               // 1 gen, 0 FP — HCP engagements analyst (J&J)
    'pcr assay',                     // 1 gen, 0 FP — PCR assay development (IDEXX)
    'clinical pathology',            // 1 gen, 0 FP — clinical pathology (IDEXX)
    'upstream qbd',                  // 1 gen, 0 FP — upstream QbD development (Elanco)
    'biologist',                     // 1 gen, 0 FP — biologist (Guidehouse)
    'comparative medicine',          // 1 gen, 0 FP — comparative medicine (Intuitive)
    'health solution specialist',    // 2 gen, 0 FP — health solution specialist (USAA)
    'revenue cycle coordinator',     // 2 gen, 0 FP — revenue cycle coordinator
    'revenue cycle case',            // 1 gen, 0 FP — revenue cycle case mgmt (athenahealth)
    'patient experience specialist', // 1 gen, 0 FP — patient experience

    'ergonomist',                   // 1 gen, 0 FP — ergonomist

    'purification development',      // 1 gen, 0 FP — protein purification R&D
    'scientific compliance',         // 1 gen, 0 FP — scientific compliance
    'biologics drug substance',      // 1 gen, 0 FP — biologics drug substance
    'peptide synthesis',             // 1 gen, 0 FP — peptide synthesis
    'translational precision medicine', // 1 gen, 0 FP — translational precision medicine
    'hematopathologist',            // 1 gen, 0 FP — Hematopathologist (Guidehouse)
    'ip quality reviewer',          // 1 gen, 0 FP — Remote IP Quality Reviewer (Guidehouse HIM)
    'hospital admissions rep',      // 2 gen, 0 real FP — fixes misclassified ops→healthcare (Guidehouse)
    'medical affairs',              // 1 gen, 0 FP — AD Medical Affairs (AbbVie)
    'protein analytics',            // 1 gen, 0 FP — Scientist I Protein Analytics (AbbVie PDS&T)
    'histology',                    // 1 gen, 0 FP — Scientist II Histology (AbbVie); fixes 2 Exact Sciences ops→healthcare misclassifications
    'pds&t',                        // 1 gen, 0 FP — AD Technical PDS&T (AbbVie Product Development Science & Technology)
    'managed care',                 // 2 gen, 0 FP — Managed Care Contracting Specialist (Abbott); also Guidehouse healthcare managed care
    'laboratory supervisor',        // 3 gen, 0 FP — Laboratory Supervisor QC (Abbott), Lab Supervisor (IDEXX, Veolia env lab)
    // TAG-11 C56: Elanco healthcare/animal health roles
    'feed additive',                // 1 gen, 0 FP — Advisor – Feed Additive Assay & Generic Defense (Elanco; animal health feed additive testing/HPLC-MS methodology)
    // TAG-PRECISION-14: high-impact healthcare keywords
    'scientist i',                  // 26 gen — pharma/biotech lab scientist level I (Thermo Fisher, AbbVie, Merck)
    'scientist ii',                 // 12 gen — pharma/biotech lab scientist level II
    'lab scientist',                // 2 gen — lab scientist applications (Thermo Fisher)
    'postdoctoral',                 // 18 gen — postdoctoral researcher/fellow (academic/medical)
    'clinical research',            // 4 gen — clinical research coordinator/associate
    // TAG-PRECISION-17 (B36): healthcare keyword gaps
    'field reimbursement',          // 8 gen — pharma field reimbursement (AbbVie, J&J)
    'clinical data',                // 3 gen — clinical data management (AbbVie)
    'clinical documentation',       // 1 gen — clinical documentation (AbbVie)
    'patient care coordinator',     // 1 gen — patient care coordination (AbbVie)
    'lab services',                 // 1 gen — lab services specialist (AbbVie)
  ];
  // \bnurse\b catches bare 'nurse' titles (charge nurse, nurse educator, etc.)
  // without matching 'nursery'. Short credentials use word-boundary to avoid false positives.
  // AEMT (Advanced EMT) added as word-boundary credential.
  const healthcareCredentials = /\b(nurse|rn|lpn|cna|crna|np|aemt|emt)\b/i;
  // 'social worker' only in hospital context — title-match is sufficient since hospital Workday tenants
  // won't title non-clinical social work roles as 'social worker' without qualification
  const healthcareOther = ['social worker', 'medical social worker', 'clinical social worker',
    'qc scientist', 'clinical scientist', 'clinical application'];
  // TAG-13: 'mental health' uses word-boundary regex — 'environmental' contains 'mental' substring
  const mentalHealthRegex = /\bmental health\b/i;
  if (
    healthcareExact.some(kw => title.includes(kw)) ||
    healthcareCredentials.test(title) ||
    healthcareOther.some(kw => title.includes(kw)) ||
    mentalHealthRegex.test(title)
  ) {
    const hcMatch = findMatch(healthcareExact, title) || (healthcareCredentials.test(title) ? 'credential regex' : null) || findMatch(healthcareOther, title) || (mentalHealthRegex.test(title) ? 'mental health (regex)' : null);
    // TAG-PRECISION-2: Sales/ops roles at pharma/med-device companies match disease-area
    // keywords (oncology, cardiovascular, endoluminal) but are sales/ops, not clinical.
    // "Oncology Territory Manager" = pharma sales rep, not oncologist.
    // "Key Account Manager, Oncology" = account management, not clinical.
    // Guard: if the ONLY healthcare match is a disease/therapy keyword AND the title
    // contains sales/ops keywords, route to sales/ops instead of healthcare.
    const diseaseAreaKws = ['oncology', 'cardiovascular', 'endoluminal', 'clinical territory', 'spine specialist', 'interventional specialist', 'clinical account'];
    const isSalesTitle = /\b(sales|territory|account manager|account exec|key account|business development)\b/i.test(title);
    const isOpsTitle = /\b(operations manager|program operations)\b/i.test(title);
    const onlyDiseaseMatch = diseaseAreaKws.some(kw => title.includes(kw)) &&
      !healthcareExact.some(kw => !diseaseAreaKws.includes(kw) && title.includes(kw)) &&
      !healthcareCredentials.test(title) &&
      !healthcareOther.some(kw => title.includes(kw)) &&
      !mentalHealthRegex.test(title);
    // TAG-PRECISION-9: 'research associate' — finance/strategy/program RAs are not healthcare.
    // "Equity Research Associate" (KeyBank) = finance, not clinical. "Strategy Research Associate"
    // (Rockstar Games) = product/strategy, not clinical. Guard fires when sole HC keyword match
    // AND title contains non-HC context (equity, investment, crypto, strategy, creator, program, client).
    // Genuines preserved: Clinical RA (Personalis, Neuralink), genomics/biotech RA (CZ Biohub, Arc Institute).
    const isNonHcResearchAssoc = /\b(equity|equities|investment|crypto|strategy|creator|program|client)\b/i.test(title);
    const onlyRaMatch = title.includes('research associate') &&
      !healthcareExact.some(kw => kw !== 'research associate' && title.includes(kw)) &&
      !healthcareCredentials.test(title) &&
      !healthcareOther.some(kw => title.includes(kw)) &&
      !mentalHealthRegex.test(title);
    if (onlyDiseaseMatch && isSalesTitle) {
      pushTag('sales', hcMatch, 'title');
    } else if (onlyDiseaseMatch && isOpsTitle) {
      pushTag('operations', hcMatch, 'title');
    } else if (onlyRaMatch && isNonHcResearchAssoc) {
      // Skip healthcare — these are finance/strategy/program roles.
      // Finance RAs may match finance keywords below, otherwise correctly fall to general.
    } else {
      pushTag('healthcare', hcMatch, 'title');
    }
  }

  // Finance / Quant domain (title-only — function-based, not employer-based)
  // Matches quant trading/research roles regardless of which firm posts them.
 // GENERAL-CLASSIFICATION expansion: added banking/accounting roles.
  // Guard: SWE roles at trading firms stay tagged 'software' — function matters, not employer.
  const financeKeywords = [
    'quantitative trader', 'quantitative researcher', 'quantitative developer',
    'quantitative analyst', 'quant trader', 'quant researcher', 'quant developer',
    'quant strategist', 'quant analyst', 'trading engineer', 'trading strategist',
    'broker trader', 'floor trader', 'options trader', 'derivatives trader',
    'algorithmic trader', 'algo trader', 'market maker', 'execution trader',
    'investment analyst', 'portfolio analyst', 'risk analyst',
 // GENERAL-CLASSIFICATION additions — +1,859 verified from live pool):
    'financial analyst', 'financial advisor', 'financial consultant',
    'financial counselor', 'financial representative', 'financial service',
    'loan officer', 'credit analyst',
    'teller',                   // bank teller — #1 hit (1,400+ jobs from WF/BofA/Chase/PNC)
    'accountant',               // accountant — (bare 'accounting' NOT added: 'Accounting Technology Consultant' FP)
    'tax analyst', 'payroll',
    'treasury analyst',
    'actuary', 'actuarial',
    'underwriter',
    'personal banker', 'universal banker', 'banker', // retail banking roles
    'property adjuster',            // 35 hits — property/auto claims adjusters (insurance)
    'branch ambassador',            // 27 hits — bank branch ambassadors (Capital One, Chase)
    'finance analyst',              // 19 hits — financial analysis roles
    'investment consultant',        // 14 hits — wealth management consulting
    'cost control analyst',         // 12 hits — defense program cost analysis
    'client relationship',          // 21 hits — Morgan Stanley/WF client relationship analyst
    'private wealth',               // 11 hits — Morgan Stanley/Goldman private wealth associate/officer
    'client service associate',     // 84 hits — Morgan Stanley/Ameriprise FINRA-licensed wealth mgmt
    'finance intern',               // 9 hits — finance internship roles
    'claims adjuster',              // 5 hits — property/commercial/marine insurance adjusters
    'claims examiner',              // 4 hits — disability/accident/federal claims examiners
    'injury adjuster',              // 3 hits — personal injury insurance adjusters
    'accounting intern',            // 5 hits — accounting internship roles
    'pricing analyst',              // 4 hits — pricing/revenue analysis
    'fp&a',                         // 3 hits — financial planning & analysis
    'client service excellence',    // 8 gen — Morgan Stanley FINRA-licensed reps
    'client service specialist',    // 6 gen — Morgan Stanley client service
    'planning consultant',          // 48 gen — Fidelity financial planning consultants
    'retirement income',            // 6 gen — USAA retirement income advisors
    'insurance professional',       // 5 gen — USAA insurance sales
    'wealth management associate',  // 3 gen — Morgan Stanley wealth advisory
    'risk officer',                 // 3 gen — Morgan Stanley risk/compliance
    'auto adjuster',                // 6 gen — auto insurance adjusters (USAA)
    'auto service representative',  // 1 gen — auto insurance service (Hartford)
    'life solutions',               // 12 gen — USAA life insurance specialists
    'corporate development',        // 10 gen — M&A/corporate strategy
    'ultra high net worth',         // 3 gen — UHNW client service (Vanguard)
    'risk strategist',              // 2 gen — risk strategy roles
    'cost analyst',                 // 7 gen — cost analysis roles
    'underwriting',                 // 7 gen — insurance underwriting
    'fraud',                        // 6 gen — fraud investigation/analysis
    'controllership',               // 1 gen — financial controllership
    'compliance aml',               // 2 gen — AML compliance
    'originations',                 // 5 gen — loan/mortgage originations
    'economist',                    // 3 gen — research economists
    'quantitative modeler',         // 1 gen — quant modeling
    'quantitative trading',         // 1 gen — quant trading (had 'trader' not 'trading')
    'loan servicing',               // 1 gen — loan servicing roles
    'budget analyst',               // 1 gen — budget analysis
    'cost and schedule',            // 3 gen — program cost/schedule control
    'workers compensation',         // 1 gen — workers comp claims
    'reinsurance',                  // 1 gen — reinsurance analysis
    'remittance processing',        // 6 gen — payment processing
    'business service officer',     // 5 gen — financial services officers
    'fund accounting',              // 4 gen — fund accounting/administration
    'private equity',               // 4 gen — PE roles
    'private credit',               // 4 gen — credit fund roles
    'risk engineer',                // 6 gen, 0 FP — insurance risk engineering (AIG, Hartford)
    'client case representative',   // 3 gen, 0 FP — financial client case management
    'retirement education',         // 2 gen, 0 FP — retirement planning education
    'claim representative',         // 1 gen, 0 FP — insurance claims
    'countrywide coverage',         // 1 gen, 0 FP — insurance underwriting coverage
    'absence management',           // 1 gen, 0 FP — insurance absence/disability mgmt
    'sovereign analyst',            // 1 gen, 0 FP — sovereign debt analysis
    'finance & strategy',           // 4 gen, 0 FP — finance & strategy roles (Netflix)
    'partnerships finance',         // 2 gen, 0 FP — partnerships finance (Netflix)
    'analyst pricing',              // 1 gen, 0 FP — pricing analysis
    'foreign military sales',       // 1 gen, 0 FP — FMS analyst (defense)
    'pcard analyst',                // 1 gen, 0 FP — PCard/travel expense analyst
    'transaction monitoring',       // 2 gen, 0 FP — AML transaction monitoring
    'loan reconciliation',          // 1 gen, 0 FP — loan reconciliation
    'financial operations consultant', // 1 gen, 0 FP — financial ops consulting
    'financial intelligence',       // 1 gen, 0 FP — financial intelligence/AML
  
    'order administrator',           // 1 gen, 0 FP — order administration
    'proposal analyst',              // 1 gen, 0 FP — proposal analysis
    'program cost controls',         // 1 gen, 0 FP — program cost controls
    'financial associate',           // 1 gen, 0 FP — financial associate
    'cost recovery',                 // 1 gen, 0 FP — cost recovery advisor
    'risk management assurance',     // 1 gen, 0 FP — risk management assurance
    'price to win',                  // 1 gen, 0 FP — price-to-win analysis
    'fms analyst',                   // 1 gen, 0 FP — foreign military sales analyst
    'global financial audit',        // 1 gen, 0 FP — global financial audit
    'customs valuation',             // 1 gen, 0 FP — customs valuation compliance
    'tariff classification',         // 1 gen, 0 FP — tariff classification
    'insurance claims',              // 1 gen, 0 FP — insurance claims specialist
    'commercial loan',               // 1 gen, 0 FP — commercial loan operations
    'financial products',            // 1 gen, 0 FP — financial products strategy
    'broker data',                   // 1 gen, 0 FP — broker data associate
    'broker relations',              // 1 gen, 0 FP — broker relations analyst
    'fund flow',                     // 2 gen, 0 FP — fund flow analyst/strategist
    'quantitative strategist',       // 4 gen, 0 FP — quantitative strategist
    'global pricing',                // 1 gen, 0 FP — global pricing & access
    'corporate tax',                 // 3 gen, 0 FP — corporate tax
    'rating analyst',                // 1 gen, 0 FP — credit rating analyst
    'tax compliance',                // 1 gen, 0 FP — tax compliance
    'agent services',                // 1 gen, 0 FP — agent services (syndicated loans)
    'finance rotational',            // 1 gen, 0 FP — finance rotational program (WD)
    'tax & treasury',                // 1 gen, 0 FP — tax & treasury (Dropbox)
    'junior valuation',              // 1 gen, 0 FP — valuation analyst
    'portfolio management',          // 1 gen, 0 FP — portfolio management (AmEx)
    'compliance high-risk',          // 1 gen, 0 FP — compliance high-risk due diligence (AmEx)
    'investment associate',          // 2 gen, 0 FP — investment associate (Wintermute)
    'paraplanner',                   // 1 gen, 0 FP — paraplanner (Ameriprise)
    'private debt',                  // 1 gen, 0 FP — private debt (Audax Group)
    'crypto researcher',             // 2 gen, 0 FP — crypto researcher (Jump Trading)
    'transfer agency',               // 2 gen, 0 FP — transfer agency (State Street)
    'annuities',                     // 2 gen, 0 FP — annuities (Prudential)
    'ltd claims',                    // 1 gen, 0 FP — LTD claims (Prudential)
    'edgar filing',                  // 1 gen, 0 FP — EDGAR filing (Broadridge)
    'recovery specialist',           // 1 gen, 0 FP — loss recovery (AIG)
    'policy wording',                // 1 gen, 0 FP — policy wording (AIG)
    'uw specialist',                 // 1 gen, 0 FP — underwriting specialist (AIG)
    'aml special investigations',    // 1 gen, 0 FP — AML investigations (Capital One)
    'anti-money laundering',         // 1 gen, 0 FP — AML data analysis (Capital One)
    'governance documentation',      // 1 gen — governance documentation specialist
    'governance framework',          // 1 gen — governance framework analyst
    'associate finance director',    // 1 gen, 0 FP — Associate Finance Director ESSM (RTX)
    'finance & controlling',         // 1 gen, 0 FP — Finance & Controlling Intern (Bosch)
    'assistant finance controller',  // 1 gen, 0 FP — Assistant Finance Controller Tempe Manufacturing (AbbVie)
    'shareholding',                  // 1 gen, 0 FP — Substantial Shareholding Disclosures Specialist (Vanguard; cross-jurisdictional regulatory reporting)
    'structured products',           // 1 gen, 0 FP — Analyst, Structured Products Group (Capital One; fixed income/credit derivatives analysis)
    'sox advisory',                  // 1 gen, 0 FP — IT SOX Risk Principal Associate, SOX Advisory Team (Capital One; Sarbanes-Oxley IT risk compliance)
    'aml content',                   // 1 gen, 0 FP — Senior Associate, Process Manager - AML Content Developer (Capital One; anti-money laundering compliance)
    'financial analysis for risk',   // 1 gen, 0 FP — Principal Associate, Financial Analysis for Risk (Capital One; financial risk analysis)
    'investment banking associate',  // 2 gen, 0 FP — TripleTree + KippsDeSanto Investment Banking Associate (Capital One subsidiaries; M&A/advisory services)
    'risk advisor',                  // 1 gen, 0 FP — Principal Associate Risk Advisor (Capital One; ORM operational risk management)
    'risk management, policy',       // 1 gen, 0 FP — Principal Associate, Risk Management, Policy Analyst (Capital One; enterprise risk policy; comma guard makes safe)
    'enterprise risk organization',  // 1 gen, 0 FP — Associate, Enterprise Risk Organization Chief of Staff (Capital One; ERO governance/oversight)
    'edata risk',                    // 1 gen, 0 FP — Principal Associate, eData Risk Guide (Capital One; Enterprise Services Risk data risk management)
    'senior tax associate',          // 1 gen, 0 FP — Senior Tax Associate, Corporate, Income Franchise (Capital One; state tax accounting/reporting)
    // TAG-11 C55: CACI finance roles
    'program finance',               // 1 gen, 0 FP — Program Finance & Controls Analyst (CACI; program-level financial controls/planning for defense contracts)
    'financial planning and analysis', // 1 gen, 0 FP — Analyst, Financial Planning and Analysis (CACI; FP&A for defense programs)
    // C58: banking/finance keyword gaps
    'banking associate',          // 34 gen — TD Bank customer-facing banking roles
    'financial reporting',        // 3 gen — financial reporting analyst
    'finance specialist',         // 3 gen — finance specialist roles
    'import-export auditor',      // 1 gen — trade compliance auditing
    // TAG-PRECISION-14: high-impact finance keywords
    'finance manager',               // 25 gen — corporate finance management
    'financial wellness associate',  // 13 gen — KeyBank financial wellness products
    'branch manager',                // 14 gen — bank branch management
    'claims analyst',                // 8 gen — insurance claims analysis
    // TAG-PRECISION-17 (B36): finance keyword gaps
    'relationship manager',         // 30 gen — banking relationship manager (Capital One, Citi, KeyBank, TD Bank, Vanguard)
    'energy trading',               // 1 gen — energy trading analyst
  ];
  if (financeKeywords.some(kw => title.includes(kw))) {
    pushTag('finance', findMatch(financeKeywords, title), 'title');
  }

  // Sales domain (title-only — description contamination risk high)
  // Guard: DO NOT add bare 'sales engineer' or 'solutions engineer' — those are tech-adjacent
  const salesKeywords = [
    'retail sales consultant', 'field sales representative',
    'sales development representative', 'account executive',
    'business development representative', 'b2b sales',
    'sales consultant', 'sales associate',
    'outside sales representative', 'inside sales',
    'sales account executive', 'enterprise account executive',
    'commercial account executive', 'sales specialist',
 // GENERAL-CLASSIFICATION additions — +377 verified from live pool):
    'sales representative',  // field/territory/medical/pharma sales reps
    'sales trainee',         // training programs at pharma/medical device companies
    'sales executive',       // entry-level sales exec titles
 // TAG-1 G1 expansion: consulting/solution sales
    'solution consultant',   // 65 hits — advisory/consulting sales (Deloitte, etc.)
    'sales trainer',         // 10 hits — pharma/medical device sales trainers (AbbVie, Abbott)
    'account development',   // 7 hits — account development representatives
    'solutions consultant',  // 8 gen, 100% spec — pre-sales/advisory consulting
    'area access executive', // 8 gen — AbbVie pharma field sales
    'field sales rep',       // 5 gen — territory field sales reps (JCI)
    'presales engineer',     // 2 gen — pre-sales engineering (Motorola)
    'solutions specialist',  // 19 gen — solutions/pre-sales specialists
    'account specialist',    // 13 gen — account management specialists
    'client partner',        // 7 gen — client partnership/sales roles
    'market development',    // 5 gen — market development representatives
    'sales support',         // 5 gen — sales support roles
    'sales intern',          // 6 gen, 0 FP — sales internships
    'sales admin',           // 4 gen, 1 FP — sales administration roles
    'sales coordinator',     // 1 gen, 0 FP — sales coordination
    'sales excellence',      // 1 gen, 0 FP — sales enablement/excellence
    'advisor consultant',    // 5 gen, 0 FP — insurance retail sales advisors
    'advisor support',       // 1 gen, 0 FP — sales support advisors
    'provider specialist',   // 2 gen, 0 FP — pro customer sales (Lowe's)
    'central selling',       // 1 gen, 0 FP — central selling supervisor
    'digital sales planner', // 2 gen, 0 FP — programmatic/digital ad sales (NBCU)
    'proposal specialist',   // 1 gen, 0 FP — proposal/bid writing (Oshkosh)
    'sales controlling',            // 2 gen, 0 FP — sales controlling analyst

    'hospital surgical rep', // 2 gen, 0 FP — hospital surgical sales rep
    'virtual sales rep',     // 1 gen, 0 FP — virtual sales representative
    'ciso solutions',        // 1 gen, 0 FP — CISO solutions GTM
    'ad sales intelligence', // 1 gen, 0 FP — enterprise ad sales intelligence
    'wellbore intervention', // 1 gen, 0 FP — wellbore intervention sales
    'refinery account',      // 1 gen, 0 FP — refinery account rep
    'enterprise renewals',   // 1 gen, 0 FP — enterprise renewals specialist
    'growth development representative', // 1 gen, 0 FP — growth dev rep
    'fire service sales',       // 2 gen, 0 FP — fire service sales (JCI)
    'commercial security services', // 1 gen, 0 FP — commercial security renewals (JCI)
    'new technology specialist', // 1 gen, 0 FP — new technology specialist (J&J)
    'sales partnerships',       // 1 gen, 0 FP — sales partnerships enablement
    'client service partner',    // 2 gen, 0 FP — client service partner (Bloomberg)
    'relationship partner',      // 2 gen, 0 FP — relationship partner
    'sales development supervisor', // 1 gen, 0 FP — sales dev supervisor
    'aftermarket solutions',    // 1 gen, 0 FP — aftermarket solutions (Caterpillar)
    'clean energy solution',    // 1 gen, 0 FP — clean energy solution specialist (Generac)
    'emergency medicine executive', // 1 gen, 0 FP — emergency medicine executive (Abbott)
    'partner solution specialist', // 2 gen, 0 FP — partner solution specialist (Autodesk)
    'renewals representative',   // 4 gen, 0 FP — renewals rep (Autodesk)
    'expansion account',         // 1 gen, 0 FP — expansion account rep
    'technical adoption',        // 1 gen, 0 FP — technical adoption specialist
    'vacation club',             // 1 gen, 0 FP — Disney Vacation Club Preview Center Assistant
    'key account sales',         // 1 gen, 0 FP — Key Account Sales Caterpillar North America (Bosch)
    'incentive compensation',    // 1 gen, 0 FP — AD Sales Planning & Incentive Compensation (AbbVie)
    'sales planning & incentive', // 1 gen, 0 FP — AD Sales Planning & Incentive Compensation (AbbVie, broader guard)
    'workday sales enablement',  // 1 gen, 0 FP — Workday Sales Enablement Specialist (Guidehouse) [sales ops using Workday platform]
    'direct sales',                 // 6 gen, 0 FP — Direct Sales Rep (Abbott x4), Direct Sales (AIG), MAE Direct Sales (TransUnion)
    'sales development intern',     // 2 gen, 0 FP — Sales Development Intern (Bosch; demand gen, email/web/social, customer ROI journey)
    'sales planner',                // 1 gen, 0 FP — Sales Planner, NBC4 & T52 Los Angeles (NBCUniversal; local TV ad sales planning)
    // TAG-PRECISION-14: high-impact sales keywords
    'account manager',              // 191 gen — B2B account management is sales (guard: not TAM)
    'territory manager',            // 22 gen — pharma/medical device territory = sales
    'sales operations',             // 13 gen — sales ops/admin roles
    'sales enablement',             // 10 gen — sales enablement/training roles
  ];
  const isSalesEngineer = /\b(sales engineer|solutions engineer|pre-sales engineer)\b/i.test(title);
  // TAG-PRECISION-14: Technical/Software/Enterprise Account Managers are tech-adjacent, not sales.
  // "Software Technical Account Manager" (Axon), "Technical Account Manager" (Adobe, Stripe) —
  // these manage technical relationships, not sales quotas.
  const isTamNotSales = /\b(technical account|software.*account|strategic account|enterprise.*account)\b/i.test(title) &&
    /\b(software|technical|strategic|enterprise)\b/i.test(title);
  if (!isSalesEngineer && !isTamNotSales && salesKeywords.some(kw => title.includes(kw))) {
    pushTag('sales', findMatch(salesKeywords, title), 'title');
  }

  // Marketing domain (title-only)
  const marketingKeywords = [
    'marketing manager', 'marketing coordinator', 'marketing analyst',
    'digital marketing', 'growth marketing', 'brand manager',
    'content marketing', 'product marketing', 'social media manager',
    'marketing associate', 'marketing specialist', 'email marketing',
    'marketing intern', 'seo specialist',
 // GENERAL-CLASSIFICATION additions — +129 verified from live pool):
    'student marketeer',    // Red Bull campus ambassador program — 129 hits, all legitimate
    'copywriter',            // 3 hits — advertising/creative copywriters
    'photographer',          // 4 hits — news/marketing photographers
    'publicist',             // 1 hit — PR/publicity roles
    'social media',          // 9 gen, 75% spec — social media coordinator/manager
    'café ambassador', 'cafe ambassador', // 6 gen — Capital One café retail roles
    'thought leader',            // 3 gen — thought leader liaison (pharma marketing)
    'account supervisor',        // 2 gen — agency account supervisors
    'communications coordinator',// 4 gen — corporate communications
    'community engagement',      // 3 gen — community relations/outreach
    'proposal content',          // 1 gen — proposal content development
    'media specialist',          // 1 gen — media/social media specialists
    'communications intern',     // 6 gen, 1 FP — corporate communications internships
    'brand marketing',           // 2 gen, 0 FP — brand marketing roles
    'internal communications',   // 2 gen, 0 FP — corporate internal comms
    'marketing attribution',     // 1 gen, 0 FP — marketing measurement/attribution
    'screenings researcher',     // 1 gen, 0 FP — content research (Netflix)
    'ads marketing operations',  // 1 gen, 0 FP — ads marketing ops
    'assignment desk',           // 4 gen, 0 FP — news assignment desk (NBCU)
    'global publicity',          // 2 gen, 0 FP — global publicity/PR (NBCU)
    'casting coordinator',       // 2 gen, 0 FP — casting/talent coordination (NBCU)
    'trade marketing',           // 1 gen, 0 FP — trade/channel marketing
    '360 designer',              // 1 gen, 0 FP — 360/multiplatform design (NBCU)
    'creative director',             // 2 gen, 0 FP — creative director
    'rx ads',                        // 1 gen, 0 FP — Rx ads & promotions
    'omnichannel',                   // 1 gen, 0 FP — omnichannel/digital operations
    'newsletter editor',             // 3 gen, 0 FP — newsletter editing (Bloomberg)
    'demand gen specialist',         // 1 gen, 0 FP — demand gen (SharkNinja)
    'consumer insights',             // 1 gen, 0 FP — consumer insights (SharkNinja)
    'localization specialist',       // 1 gen, 0 FP — localization (Life.Church)
    'b2b digital strategy',          // 1 gen, 0 FP — B2B digital strategy (Elanco)
    'content programmer',            // 2 gen, 0 FP — content programming (WBD)
    'video and audio editor',        // 1 gen, 0 FP — video/audio editing (WBD/CNN)
    'editor-writer',                 // 1 gen, 0 FP — editor-writer (WBD/CNN)
    'tiktok social programming',     // 1 gen, 0 FP — TikTok social (WBD/BR)
    'multi-media journalist',        // 1 gen, 0 FP — multimedia journalist (NBCU)
    'youth programs marketing',      // 1 gen, 0 FP — youth programs marketing (Red Bull)
    'editor, politics',              // 1 gen, 0 FP — politics editor (WBD)
    'founding marketer',             // 1 gen, 0 FP — founding marketer (Gimlet Labs)

    'consumer intelligence',        // 1 gen, 0 FP — consumer intelligence research (GM)
    'spaceport designer',           // 1 gen, 0 FP — spaceport interior design (SpaceX)

    'hcp marketing',             // 1 gen, 0 FP — HCP marketing
    'professional marketing',    // 3 gen, 0 FP — professional/OTC marketing
    'copy supervisor',           // 1 gen, 0 FP — copy supervisor (creative)
    'digital lab banner',        // 1 gen, 0 FP — digital lab banner ads
    'avod',                      // 1 gen, 0 FP — AVOD Growth & Digital Dist. (NBCUniversal)
    'nbc sports digital',        // 1 gen, 0 FP — NBC Sports Digital Programming (NBCUniversal)
    'global platform partnerships', // 2 gen, 0 FP — Global Platform Partnerships (NBCUniversal)
    'audience acquisition',      // 1 gen, 0 FP — Audience Acquisition & Growth (NBCUniversal)
    'partner marketing',         // 1 gen, 0 FP — Partner Marketing Manager (NBCUniversal)
    'digital communications',    // 1 gen, 0 FP — Digital Comms Specialist (NBCUniversal)
    'seo intern',                // 1 gen, 0 FP — ABC News SEO Intern (Disney)
    'brand team lead',           // 3 gen, 0 FP — Director Brand Team Lead IMCO (AbbVie global brand)
    'consumer marketing',        // 2 gen, 0 real FP — AD Consumer Marketing (AbbVie); fixes Takeda healthcare→marketing misclassification
    'portfolio marketing',       // 1 gen, 0 FP — AD Innovation & Portfolio Marketing (AbbVie)
    'innovation & portfolio',    // 1 gen, 0 FP — AD Innovation & Portfolio Marketing (AbbVie, broader guard)
    'advertising and design',    // 1 gen, 0 FP — Advertising and Design Specialist (Bosch)
    'marketing programs',        // 1 gen, 0 FP — Marketing Programs & Communications Specialist (Caterpillar)
    'crm marketing',             // 1 gen, 0 FP — CRM Marketing Operations Intern (WBD; marketing automation/CRM operations)
    'design and advertising',    // 1 gen, 0 FP — Design and Advertising Intern (Bosch; branding, marketing design, digital/print campaigns)
    'search engine optimization', // 1 gen, 0 FP — Search Engine Optimization (SEO) Specialist (Vanguard; SEO/GEO/AISO program)
    'ux content strategist',     // 1 gen, 0 FP — UX Content Strategist, Specialist (Vanguard; content strategy, UX writing)
    'market research intern',    // 1 gen, 0 FP — Technology Market Research Intern - Strategy and Operations (Applied Materials; market research/competitive intelligence intern)
    'specialist, performance marketing', // 2 gen, 0 FP — Specialist, Performance Marketing (NBCUniversal; paid search/programmatic advertising)
    'paid search',               // 1 gen, 0 FP — Specialist, Performance Marketing – Paid Search and Programmatic (NBCUniversal)
    'social strategy',           // 1 gen, 0 FP — Coordinator, Social Strategy & Insights (NBCUniversal; NBC Sports social marketing)
    'development-peacock',       // 2 gen, 0 FP — Specialist, Development-Peacock (NBCUniversal ×2; Peacock streaming partnerships/marketing)
    'coordinator, marketing',    // 1 gen, 0 FP — Coordinator, Marketing Strategy (NBCUniversal; entertainment marketing strategy)
    'peacock marketing',         // 1 gen, 0 FP — Associate Manager, NBC & Peacock Marketing (NBCUniversal)
    'brand agency',              // 1 gen, 0 FP — Senior Associate, Brand Agency Relations (Capital One; creative agency sourcing/management)
    'social operations',         // 1 gen, 0 FP — Principal Associate, Social Operations & Enablement (Capital One; brand governance/social media access mgmt)
    'insights creative',         // 1 gen, 0 FP — Principal Associate, Insights Creative & Sponsorship (Capital One; creative/sponsorship marketing)
    'marketing - premium',       // 1 gen, 0 FP — Sr. Associate, Marketing - Premium Products & Experiences (Capital One; premium card acquisition/marketing; dash guard makes safe)
    // TAG-11 C54: Disney/cross-company marketing
    'communication intern',      // 1 gen, 0 FP — Disney Entertainment Television Communication Intern (singular form of existing 'communications intern')
    // TAG-11 C56: Elanco marketing roles
    'farm animal beef marketing', // 1 gen, 0 FP — Farm Animal Beef Marketing (Packaged Goods) Academic Worker (Elanco; animal health beef marketing academic internship IU-Indy)
  ];
  // TAG-9: 'producer' and 'reporter' added as guarded keywords for media/content roles
  const isInsuranceProducer = /\b(licensed|insurance|enrollment)\b/i.test(title);
  const isNonMediaReporter = /\b(litigation|analyst|legal)\b/i.test(title);
  const isAITrainer = title.includes('ai trainer') || title.includes('ai training');
  const videoEditorMatch = !isAITrainer && title.includes('video editor'); // 3 gen (Disney, WBD ×2), 0 FP — guard excludes Handshake AI trainer roles
  const seoWordMatch = /\bseo\b/i.test(job.title || ''); // word-boundary check (title.includes('seo') FPs on "Seoul")
  const producerReporterMatch = (!isInsuranceProducer && title.includes('producer')) ||
    (!isNonMediaReporter && title.includes('reporter'));
  if (marketingKeywords.some(kw => title.includes(kw)) || producerReporterMatch || videoEditorMatch || seoWordMatch) {
    const mktMatch = findMatch(marketingKeywords, title) ||
      (title.includes('producer') ? 'producer' : null) ||
      (title.includes('reporter') ? 'reporter' : null) ||
      (videoEditorMatch ? 'video editor' : null) ||
      (seoWordMatch ? 'seo' : null);
    pushTag('marketing', mktMatch, 'title');
  }

  // Operations domain (title-only — narrow terms only, avoid broad 'analyst' standalone)
  const operationsKeywords = [
    'operations analyst', 'operations associate', 'operations coordinator',
    'supply chain analyst', 'logistics analyst', 'program analyst',
    'project analyst', 'business operations', 'strategy analyst',
    'strategy associate', 'operations specialist',
 // TAG-1 G1 expansion: supervisor + inventory roles
    'shift supervisor',          // 171 hits — CVS/retail/manufacturing floor supervisors
    'operations supervisor',     // 48 hits
    'inventory specialist',      // 73 hits — auto auction/warehouse inventory
    // Was causing 225 ops-only misroutes (Lowe's warehouse, Red Bull fulfillment).
    'customer service representative', // 65 hits — CSR roles
    'management analyst',        // 31 hits — management consulting/analysis
    'support analyst',           // 23 hits — operations support analysis
    'buyer',                     // 33 hits — procurement/purchasing buyer roles
    'business analyst',          // 63 hits — business analysis across industries
    'procurement specialist',    // 4 hits — procurement roles
    'project coordinator',       // 16 hits — project coordination roles
    'service coordinator',       // 3 hits — service coordination roles
    'operations asm',            // 4 hits — assistant store manager (operations)
    'procurement analyst',       // 3 hits — procurement analysis
    'operations support',        // 3 hits — operations support specialist/analyst
    'supply chain',              // 101 gen — broader form (had only 'supply chain specialist/coordinator')
    'customer service',          // 68 gen — broader form (had only 'customer service representative')
    'operations technician',     // 23 gen — operations/facilities technicians
    'support associate',         // 10 gen — operations support roles
    'technical consultant',      // 12 gen — consulting/advisory roles
    'sourcing specialist',       // 7 gen — procurement sourcing
    'production operations',     // 9 gen — production operations roles
    'scheduling staffing',       // 10 gen — scheduling/staffing admin roles
    'site manager',              // 8 gen — assistant site managers
    'customs specialist',        // 6 gen — customs/trade compliance
    'executive protection',      // 3 gen — corporate security/protection
    'workplace coordinator',     // 3 gen — facilities/workplace coordination
    'production and inventory',  // 3 gen — production/inventory coordination
    'yard supervisor',           // 2 gen — yard/lot management (Copart)
    'program controls',          // 2 gen — program controls analysis (Moog defense)
    'customer support agent',    // 4 gen — customer support roles
    'physical security',         // 11 gen — physical security officers/investigators
    'console operator',          // 9 gen — security console operators
    'background investigator',   // 10 gen — federal background investigators (CACI)
    'security officer',          // 9 gen — physical security officers (USAA, Hermeus)
    'customer care',             // 8 gen — customer care representatives/advocates
    'master scheduler',          // 4 gen — program/master schedulers
    'close protection',          // 3 gen — executive protection officers
    'baggage handling',          // 2 gen — airport baggage operations
    'motor transport',           // 3 gen — military motor transport (KBR)
    'industrial security',       // 6 gen — industrial security specialists
    'assistant general manager', // 3 gen — facility/store AGMs
    'import/export',             // 2 gen — trade compliance analysts
    'custodian',                 // 4 gen — custodial/janitorial
    'targeter',                  // 2 gen — intelligence targeting (Booz Allen)
    'surveillance analyst',      // 3 gen — surveillance/monitoring analysts
    'sous chef',                 // 3 gen — kitchen sous chefs (SpaceX)
    'janitor',                   // 5 gen — janitorial roles
    'food service',              // 4 gen — food service specialists
    'subject matter expert',     // 8 gen — defense/consulting SMEs
    'planning and scheduling',   // 5 gen — program planning/scheduling
    'player tracking',           // 4 gen — sports tracking systems (Zebra)
    'military fellowship',       // 5 gen — military SkillBridge fellowships
    'professional services consultant', // 5 gen — PS consulting
    'scheduling analyst',        // 5 gen — scheduling/planning analysts
    'business transformation',   // 8 gen — transformation program roles
    'inventory control',         // 1 gen — inventory control roles
    'protection specialist',     // 1 gen — asset/account protection
    'protection integrator',     // 1 gen — security integration
    'customer success',          // 12 gen — customer success advisors/managers
    'line cook',                 // 4 gen — kitchen line cooks
    'imagery analyst',           // 1 gen — intelligence imagery analysis
    'receptionist',              // 4 gen — front desk reception
    'trust and safety',          // 2 gen — trust & safety operations
    'operational language analyst', // 12 gen, 0 FP — military linguist/translator roles (CACI)
    'parts planner',             // 3 gen, 0 FP — material/parts planning
    'blucar support specialist', // 3 gen, 0 FP — Copart vehicle support
    'linguist interpreter',      // 2 gen, 0 FP — military interpreter roles
    'targeting officer',         // 2 gen, 0 FP — intelligence targeting roles
    'order entry',               // 2 gen, 0 FP — order entry/processing
    'construction superintendent', // 1 gen, 0 FP — construction site management
    'lab clerk',                 // 1 gen, 0 FP — laboratory clerk roles
    'materials analyst',         // 1 gen, 0 FP — materials/inventory analysis
    'strategic sourcing intern', // 1 gen, 0 FP — procurement internships
    'vehicle detailer',          // 1 gen, 0 FP — vehicle detailing/prep
    'sc security specialist',    // 3 gen, 0 FP — supply chain security (Lowe's)
    'helix data creator',        // 3 gen, 0 FP — data creation ops
    'corporate department assistant', // 1 gen, 0 FP — corporate admin
    'district support coordinator', // 1 gen, 0 FP — district operations
    'receiving support specialist', // 1 gen, 0 FP — warehouse receiving
    'assistant manager attractions', // 2 gen, 0 FP — theme park attractions (NBCU)
    'work order coordinator',    // 2 gen, 0 FP — facility work orders (Oshkosh)
    'summer help',               // 2 gen, 0 FP — seasonal help roles (Oshkosh)
    'assistant manager show',    // 1 gen, 0 FP — show quality management (NBCU)
    'culinary internship',       // 1 gen, 0 FP — food service internship (NBCU)
    'site supervisor',           // 1 gen, 0 FP — site operations supervision
    'facility support',          // 1 gen, 0 FP — facility support roles
    'intel analyst',             // 1 gen, 0 FP — intelligence analyst
    'operations integrator',     // 1 gen, 0 FP — military operations integrator
    'sensitive activities',      // 1 gen, 0 FP — sensitive activities advisor
    'procurement administrator', // 1 gen, 0 FP — procurement admin
    // 'governance documentation' MOVED to finance (TAG-12 audit: CACI Job Category = Finance and Accounting)
    // 'governance framework' MOVED to finance (TAG-12 audit: CACI Job Category = Finance and Accounting)
    // 'interface sustainment' MOVED to software (TAG-12 audit: CACI Job Category = Information Technology)
    'cryptologic language',      // 1 gen, 0 FP — cryptologic language analyst
    'fielding/training',         // 1 gen, 0 FP — equipment fielding/training
    'security cooperation',      // 3 gen, 0 FP — security cooperation specialist
    'operations warfighting',    // 2 gen, 0 FP — warfighting analyst
    'hicom',                     // 3 gen, 0 FP — HICOM integrator roles
    'fuops planner',             // 1 gen, 0 FP — future operations planner
    'foreign disclosure',        // 1 gen, 0 FP — foreign disclosure rep
    'naval experiment',          // 1 gen, 0 FP — naval experiment planner
    'joint effects',             // 1 gen, 0 FP — joint effects integrator
    'requirements integration',  // 1 gen, 0 FP — requirements integration officer
    'protocol officer',          // 1 gen, 0 FP — protocol officer
    'fires curriculum',          // 1 gen, 0 FP — fires curriculum developer
    'fires simulation',          // 1 gen, 0 FP — fires simulation operator
    'c-uas training',            // 1 gen, 0 FP — counter-UAS training
    'military capabilities',     // 1 gen, 0 FP — military capabilities analyst
    'defense mission',           // 1 gen, 0 FP — defense mission analyst
    'supplier onboarding',       // 1 gen, 0 FP — supplier onboarding specialist
    'exercise planning',         // 1 gen, 0 FP — exercise planning specialist
    'intelligence exercise',     // 1 gen, 0 FP — intelligence exercise planner
    // (Guidehouse ops keywords interspersed below)
    'operations advisor',        // 2 gen, 0 FP — operations advisor
    'deckhand',                  // 1 gen, 0 FP — maritime deckhand
    'jassm targeting',           // 1 gen, 0 FP — JASSM targeting analyst
    'triage examiner',           // 1 gen, 0 FP — triage examiners (linguist)
    'korean linguist',           // 1 gen, 0 FP — Korean linguist/translator
    'arabic linguist',           // 2 gen, 0 FP — Arabic linguist
    'bilingual linguist',        // 1 gen, 0 FP — bilingual linguist
    'weather forecaster',        // 1 gen, 0 FP — aviation weather forecaster
    'energy advisor',            // 1 gen, 0 FP — energy efficiency advisor
    'material control',          // 2 gen, 0 FP — material control stockroom
    'visual charting',           // 1 gen, 0 FP — visual charting specialist
    'documentation specialist',  // 3 gen, 0 FP — documentation specialist
    'call center',               // 1 gen, 0 FP — call center rep
    'process improvement managing', // 1 gen, 0 FP — process improvement consultant
  
    'commodity supplier',            // 1 gen, 0 FP — commodity supplier assurance
    'combat systems planning',       // 1 gen, 0 FP — combat systems planning
    'customs operations',            // 1 gen, 0 FP — customs operations import
    'supplier commodity',            // 1 gen, 0 FP — supplier commodity assurance
    'small business advocate',       // 1 gen, 0 FP — small business advocacy
    'oem support',                   // 1 gen, 0 FP — OEM support specialist
    'campaign planner',              // 1 gen, 0 FP — strategy/campaign planner
    'force operations planner',      // 1 gen, 0 FP — joint force ops planner
    'manpower analyst',              // 1 gen, 0 FP — manpower analysis
    'technical author',              // 1 gen, 0 FP — technical authoring
    'contracts support',             // 1 gen, 0 FP — contracts support SME
    'human systems integration',     // 1 gen, 0 FP — HSI specialist
    'weapon system contract',        // 1 gen, 0 FP — weapon system contract eval
    'career exploration',            // 1 gen, 0 FP — career exploration program
    'safety management system',      // 1 gen, 0 FP — SMS engineer
    'team lead - deicer',            // 1 gen, 0 FP — deicer team lead
    'technical documentation illustrator', // 2 gen, 0 FP — tech doc illustrator
    'business unit intern',          // 1 gen, 0 FP — business unit internship

    'purchasing quality',           // 1 gen, 0 FP — purchasing quality (Bosch)
    'fire captain',                 // 1 gen, 0 FP — fire captain (Disney)
    'hospitality specialist',       // 2 gen, 0 FP — hospitality specialist (SpaceX)
    'mixologist',                   // 1 gen, 0 FP — mixologist (SpaceX)
    'spaceport experience',         // 2 gen, 0 FP — spaceport experience (SpaceX)
    'gsoc operator',                // 1 gen, 0 FP — GSOC operator (SpaceX)
    'pilot in command',             // 1 gen, 0 FP — pilot in command (SpaceX)
    'payload rack officer',         // 2 gen, 0 FP — payload rack officer (FLIR)
    'field services coordinator',   // 1 gen, 0 FP — field services coord (FLIR)
    'supplier quality coordinator', // 1 gen, 0 FP — supplier quality coord (FLIR)
    'customer delivery readiness',  // 1 gen, 0 FP — customer delivery readiness (FLIR)
    'poi specialist',               // 1 gen, 0 FP — POI specialist (FLIR)

    'category management',          // 2 gen, 0 FP — category management
    'corporate catering',           // 1 gen, 0 FP — corporate catering
    'procurement agent',            // 3 gen, 0 FP — procurement agent
    'fleet monitoring',             // 1 gen, 0 FP — fleet monitoring engineer
    'customer support specialist',  // 4 gen, 0 FP — customer support specialist
    'account administrator',        // 2 gen, 0 FP — account admin
    'workplace strategy',           // 1 gen, 0 FP — workplace strategy
    'voice ordering',               // 1 gen, 0 FP — voice ordering accessibility
    'quality strategy',             // 1 gen, 0 FP — quality strategy & operations
    'proactive outreach',           // 1 gen, 0 FP — proactive outreach specialist
    'premium resolution',           // 1 gen, 0 FP — premium resolution partner
    'merchant sentiment',           // 1 gen, 0 FP — merchant sentiment specialist
    'revenue operations business partner', // 1 gen, 0 FP — revenue ops business partner
    'customer advocacy',            // 2 gen, 0 FP — customer advocacy
    'webcast',                      // 1 gen, 0 FP — webcast/AV specialist
    'contact center trainer',       // 1 gen, 0 FP — contact center training
    'construction equipment services', // 3 gen, 0 FP — construction equipment (JCI)
    'global business process owner', // 2 gen, 0 FP — GBPO (Moog)
    'skip tracer',                  // 1 gen, 0 FP — skip tracing (Motorola)
    'office stock assistant',       // 1 gen, 0 FP — office stock (Motorola)
    'supplier technologist',        // 1 gen, 0 FP — supplier technologist (Applied Materials)
    'loading dock',                 // 1 gen, 0 FP — loading dock specialist
    'fixed wing captain',           // 1 gen, 0 FP — fixed wing pilot
    'central planner',              // 1 gen, 0 FP — central planner (Polaris)
    'mailroom facilities',          // 1 gen, 0 FP — mailroom facilities (Broadridge)
    'sustainability analyst',       // 1 gen, 0 FP — sustainability analyst
    'volunteer experience',         // 1 gen, 0 FP — volunteer experience (Life.Church)
    'rfc coordinator',              // 1 gen, 0 FP — RFC coordinator (Jabil)
    'contract lifecycle',           // 1 gen, 0 FP — contract lifecycle mgmt (Philips)
    'property maintenance',         // 1 gen, 0 FP — property maintenance (SEL)
    'technical customer advisor',   // 1 gen, 0 FP — technical customer advisor (Veolia)
    'yard attendant',               // 1 gen, 0 FP — yard attendant (Copart)
    'tamashek linguist',            // 1 gen, 0 FP — Tamashek linguist (CACI)
    'service dispatch',             // 1 gen, 0 FP — service dispatch supervisor
    'intel ops controller',         // 1 gen, 0 FP — intel ops controller (CACI)
    'russian kazak',                // 1 gen, 0 FP — Russian/Kazak linguist (CACI)
    'administrative operations assistant', // 1 gen, 0 FP — admin ops assistant
    'fleet & safety',               // 1 gen, 0 FP — fleet & safety (Allegion)
    'bag jam clearer',              // 3 gen, 0 FP — bag jam clearer (Oshkosh airports)
    'transportation strategy',      // 1 gen, 0 FP — transportation strategy (Point72)
    'mission operator',             // 1 gen, 0 FP — mission operator (Latitude AI)
    'engineering projects administrator', // 1 gen, 0 FP — eng projects admin (Curtiss-Wright)
    'procurement support',          // 1 gen, 0 FP — procurement support (Guidehouse)
    'human evaluator',              // 2 gen, 0 FP — human evaluator (Roblox)
    'french /hausa',                // 1 gen, 0 FP — French/Hausa linguist (Leidos)
    'energy efficiency programs',   // 1 gen, 0 FP — energy efficiency programs (Leidos)
    'orders and demand',            // 1 gen, 0 FP — orders & demand consultant (Caterpillar)
    'dispatch operations',          // 1 gen, 0 FP — dispatch operations (Voltus)
    'intelligence planner',         // 1 gen, 0 FP — intelligence planner (Booz Allen)
    'intelligence management specialist', // 1 gen, 0 FP — intel mgmt specialist (CACI)
    'contract management specialist', // 2 gen, 0 FP — Contract Management Specialist (Boeing)
    'maintenance controller',        // 1 gen, 0 FP — Maintenance Controller F-15SA (Boeing)
    'learning strategist',           // 1 gen, 0 real FP — Associate Learning Strategist (pre-existing mfg FP)
    'material review board',         // 1 gen, 0 FP — Quality Production Spclst MRB (Boeing)
    'tech pubs author',              // 1 gen, 0 FP — Chinook Tech Pubs Author (Boeing, ops domain)
    'procurement field',             // 1 gen, 0 FP — Procurement Field Rep (Boeing)
    'database content developer',    // 1 gen, 0 FP — Database Content Developer (Boeing visual systems)
    'image process specialist',      // 1 gen, 0 FP — Associate Image Process Specialist (Boeing)
    'logistics representative',      // 2 gen, 0 FP — C-32/C-40 Logistics Representative (Boeing)
    'quality workplace coach',       // 1 gen, 0 FP — Quality Workplace Coach (Boeing manufacturing floor)
    'centurion lounge',             // 5 gen, 0 FP — Centurion Lounge (AmEx)
    'technical service trainer',    // 2 gen, 0 FP — technical service training (Generac)
    'cuas osint',                   // 1 gen, 0 FP — CUAS OSINT Analyst (CACI Intelligence)
    'sof operations',               // 1 gen, 0 FP — DTRA SOF Operations Planner (CACI Intel)
    'dtra',                         // 1 gen, 0 FP — DTRA SOF Operations Planner (CACI)
    'federal financial management', // 1 gen, 0 FP — Federal Financial Mgmt Consultant (Guidehouse)
    'future plans analyst',         // 1 gen, 0 FP — Future Plans Analyst (Guidehouse ops)
    'energy markets',               // 3 gen, 0 FP — Managing Consultant-Energy Markets (Guidehouse)
    'broadcast engineer',           // 1 gen, 0 FP — Production/Broadcast Engineer (NBCUniversal)
    'photo coordinator',            // 1 gen, 0 FP — Photo Coordinator (NBCUniversal)
    'digital scheduling',           // 1 gen, 0 FP — Digital Scheduling Supervisor (NBC Sports)
    'citywalk',                     // 2 gen, 0 FP — CityWalk Projects/Entertainment (NBCUniversal)
    'entertainment coordinator',    // 2 gen, 0 FP — Entertainment Coordinator (NBCUniversal)
    'life cycle engineering',       // 1 gen, 0 FP — Life Cycle Engineering Cross Product Team Lead (RTX)
    'advanced technology program management', // 1 gen, 0 FP — Intern Advanced Tech Program Mgmt (RTX)
    'product lifecycle services',   // 1 gen, 0 FP — Intern Product Lifecycle Services (RTX)
    'technical coordinator',        // 1 gen, 0 FP — Technical Coordinator (RTX)
    'program quality & mission',    // 1 gen, 0 FP — Program Quality & Mission Assurance Associate (RTX)
    'master control operator',      // 1 gen, 0 FP — Network Origination/Master Control Operator (Disney)
    'content planning',             // 1 gen, 0 FP — Content Planning Associate (Disney DTC)
    'audio operator',               // 1 gen, 0 FP — Audio Operator REMI A2 (ESPN/Disney)
    'export analyst',               // 1 gen, 0 FP — Export Analyst (Disney global trade)
    'podcast production',           // 1 gen, 0 FP — ABC News Podcast Production Intern (Disney)
    'dtc strategy',                 // 1 gen, 0 FP — Analyst DTC Strategy (Disney+/Hulu)
    'digital video content',        // 1 gen, 0 FP — Digital Video Content Associate (ESPN Disney+)
    'rockwork designer',            // 1 gen, 0 FP — Rockwork Designer (Walt Disney Imagineering)
    'network origination',          // 1 gen, 0 FP — Network Origination Operator (Disney broadcast)
    'franchise planning',           // 1 gen, 0 FP — WDI Franchise Planning Intern (Disney)
    'preditor',                     // 1 gen, 0 FP — Preditor producer/editor hybrid (Disney)
    'construction associate',       // 1 gen, 0 FP — Construction Associate Project Manager (Disney)
    'patient services business',         // 1 gen, 0 FP — AD Patient Services Business Design (AbbVie)
    'transformation program management', // 1 gen, 0 FP — AD Transformation Program Management (AbbVie)
    'organizational excellence',         // 1 gen, 0 FP — AD Organizational Excellence (AbbVie)
    'international planning',            // 1 gen, 0 FP — AD International Planning & Data Operations (AbbVie)
    'lean digital transformation',  // 1 gen, 0 FP — Team Lead Lean Digital Transformation (Bosch)
    'warranty and returns',         // 1 gen, 0 FP — Warranty and Returns Specialist (Bosch)
    'project purchasing',           // 1 gen, 0 FP — Project Purchasing Specialist (Bosch)
    'replenishment team lead',      // 1 gen, 0 FP — Replenishment Team Lead (Bosch warehouse)
    'geoint analyst',               // 2 gen, 0 FP — GEOINT Analyst (CACI/Leidos intelligence)
    'all source',                   // 2 gen, 0 FP — All Source Analyst + FUSION/All Source CUAS Analyst (CACI Intelligence) — bare catches slash-separated title format
    'multi-domain analyst',         // 1 gen, 0 FP — Multi-Domain Analyst (CACI Intelligence)
    'kurdish linguist',             // 1 gen, 0 FP — Kurdish Linguist (CACI/Leidos)
    'pashto',                       // 2 gen, 0 FP — Pashto/Dari Linguists (CACI/Leidos) — bare catches "Pashto/Dari" format
    'somali linguist',              // 2 gen, 0 FP — Somali Linguist (CACI)
    'russian linguist',             // 4 gen, 0 FP — Russian Linguist (CACI/Leidos)
    'farsi linguist',               // 1 gen, 0 FP — Farsi Linguist (CACI)
    'chinese linguist',             // 1 gen, 0 FP — Chinese Linguist (CACI/Leidos)
    'uzbek',                        // 1 gen, 0 FP — Uzbek & Russian Linguist (CACI)
    'tamashek',                     // 1 gen, 0 FP — Tamashek/Tamasheq Linguist (CACI)
    'lessons learned analyst',      // 1 gen, 0 FP — Lessons Learned Analyst (Booz Allen)
    'continuity of operations',     // 1 gen, 0 FP — Continuity Of Operations Planner (Booz Allen)
    'space operations',             // 1 gen, 0 FP — Combined Space Operations SME / Planner (Booz Allen)
    'space exercise',               // 1 gen, 0 FP — Space Exercise Planner (Booz Allen USSF)
    'space future operations',      // 1 gen, 0 FP — Space Future Operations Planner (Booz Allen USSF)
    'counter unmanned',             // 1 gen, 0 FP — Counter Unmanned Systems Portfolio Specialist (Booz Allen)
    'techno-economic',              // 1 gen, 0 FP — Techno-Economic Analyst (Booz Allen ARPA-E)
    'cyber policy',                 // 1 gen, 0 FP — Cyber Policy Writer (Booz Allen)
    'organizational transformation strategist', // 1 gen, 0 FP — Organizational Transformation Strategist (Booz Allen)
    'records management specialist', // 1 gen, 0 FP — Records Management Specialist (Booz Allen)
    'workforce support specialist', // 2 gen, 0 FP — Workforce Support Specialist (Booz Allen/Leidos)
    'network development analyst',  // 1 gen, 0 FP — Network Development Analyst (Booz Allen intel)
    'language-enabled analyst',     // 1 gen, 0 FP — Language-Enabled Analyst (Booz Allen intel)
    'occupational safety health',   // 2 gen, 0 FP — Occupational Safety Health Analyst (Leidos)
    'field operations tech',        // 1 gen, 0 FP — Field Operations Tech (Leidos)
    'cost estimator',               // 1 gen, 0 FP — Cost Estimator (Leidos)
    'quality control group',        // 1 gen, 0 FP — Quality Control Group Specialist (Leidos)
    'net mod training',             // 1 gen, 0 FP — NET Mod Training/Fielding Support (Leidos)
    'communications and engagement specialist', // 1 gen, 0 FP — Communications and Engagement Specialist (Leidos)
    'site security specialist',     // 1 gen, 0 FP — Site Security Specialist (Leidos)
    'health & safety technician',   // 4 gen, 0 FP — Environmental Health & Safety Technician (SpaceX)
    'facilities supervisor',        // 1 gen, 0 FP — Facilities Supervisor Starbase Village (SpaceX)
    'construction technician',      // 1 gen, 0 FP — Construction Technician (SpaceX)
    'security protective operations', // 1 gen, 0 FP — Security Protective Operations Center Operator (SpaceX)
    'u109 driver',                  // 1 gen, 0 FP — U109 Driver 1st Shift (Northrop Grumman) [program-specific driver role]
    // C58: field service keyword gap
    'field service technician',   // 28 gen — NCR Voyix ATM/POS field repair (operations)
    'site security controller',     // 1 gen, 0 FP — Site Security Controller (Northrop Grumman)
    'value chain designer',         // 1 gen, 0 FP — Value Chain Designer (Caterpillar) [supply chain design/operations]
    'machine technical services',   // 1 gen, 0 FP — Machine Technical Services Representative (Caterpillar)
    'corporate travel security',    // 1 gen, 0 FP — Corporate Travel Security Specialist (Vanguard; GR&S travel risk/security operations)
    'operational excellence engineer', // 1 gen, 0 FP — Operational Excellence Engineer – Global Logistics (Intuitive; Lean/Six Sigma logistics ops)
    'office planning',             // 1 gen, 0 FP — SDS Office Planning Representative (NG; space programs division office planning/coordination)
    'tactical strike',             // 1 gen, 0 FP — AD Tactical Strike Requirements & Capabilities (RTX; missile systems requirements definition)
    'web editor',                  // 1 gen, 0 FP — Web Editor, Telemundo T40 McAllen (NBCUniversal; digital content publishing)
    'ent audio',                   // 1 gen, 0 FP — Supervisor Ent Audio/Video (NBCUniversal; entertainment AV operations)
    'production client experience', // 1 gen, 0 FP — Production Client Experience Coordinator (NBCUniversal; studio services production support)
    'entry operations',            // 1 gen, 0 FP — Assistant Manager Entry Operations (NBCUniversal; theme park admissions/rentals/guest services)
    'telemundo t60',               // 1 gen, 0 FP — Production Operation Specialist, Telemundo T60 San Antonio (NBCUniversal; broadcast production ops)
    'telemundo responde',          // 1 gen, 0 FP — Anchor, Telemundo Responde/Investiga Las Vegas (NBCUniversal; consumer investigative journalism)
    'freelance desk',              // 1 gen, 0 FP — Freelance Desk Editor - NBC Sports (NBCUniversal; digital sports editorial)
    'nbc news washington',         // 1 gen, 0 FP — Desk Assistant, NBC News Washington (NBCUniversal; network news bureau)
    'business solutions analyst',  // 1 gen, 0 FP — Business Solutions Analyst (NBCUniversal; UP&E operational excellence/process ops)
    'hollywood drift',             // 1 gen, 0 FP — Assistant Manager Fast & Furious Hollywood Drift (NBCUniversal; theme park attraction ops)
    'researcher-nbc',              // 1 gen, 0 FP — Researcher-NBC Sports (NBCUniversal; live sports research/editorial)
    'media prep technician',       // 1 gen, 0 FP — Media Prep Technician (NBCUniversal; digital supply chain QC/transcode/delivery)
    'production & operations',     // 1 gen, 0 FP — Coordinator, Production & Operations (NBCUniversal; exec support production ops team)
    'coordinator, center',         // 1 gen, 0 FP — Coordinator, Center of Excellence (NBCUniversal; Ad Sales CoE admin/coordination)
    'coordinator, communications', // 1 gen, 0 FP — Coordinator, Communications (NBCUniversal; comms executive admin/scheduling)
    'supervisor entertainment',    // 2 gen, 0 FP — Supervisor Entertainment (NBCUniversal ×2; theme park costume/show operations)
    'product ops',                 // 1 gen, 0 FP — Product Ops. Mgr., Tooling & Automation (NBCUniversal; Peacock/NBC ops tech tooling)
    'data integrity reviewer',     // 1 gen, 0 FP — Core Ops Data Integrity Reviewer (QC) (Capital One; banking data quality review)
    'velocity black',              // 1 gen, 0 FP — Travel Specialist, Associate - Velocity Black (Capital One; luxury travel concierge/AI)
    'small business bank',         // 2 gen, 0 FP — Project Manager | Small Business Bank (Capital One ×2; SMB banking operations)
    'treasury management product', // 1 gen, 0 FP — Senior Associate, Project Manager - Treasury Management Product (Capital One; commercial bank TM product ops)
    'principal associate, business analysis', // 1 gen, 0 FP — Principal Associate, Business Analysis (Capital One; cloud transformation business analysis ops)
    'process manager, principal',  // 1 gen, 0 FP — Process Manager, Principal Associate (Capital One; ATM availability/operational efficiency)
    'supply base management',       // 1 gen, 0 FP — Supply Base Management Specialist (Boeing; supplier quality/contract compliance)
    'mro digital',                  // 1 gen, 0 FP — Digital Enablement MRO Digital / Analytics Integration Analyst (Boeing; MRO digital transformation analytics)
    'training and content',         // 1 gen, 0 FP — Associate Training and Content Specialist (Boeing BBE; visitor experience training/content design)
    'business ops specialist',      // 2 gen, 0 FP — BDS Capability Business Ops Specialist + Business Ops Specialist Airplane Programs (Boeing)
    'airplane management',          // 1 gen, 0 FP — Airplane Management Team Specialist (Boeing; airplane configuration/delivery programs)
    // TAG-11 C54: Disney/cross-company operations
    'government relations',         // 4 gen, 0 FP — Gov't relations interns/associates (Disney, Merck, NG, ADI)
    'external affairs',             // 1 gen, 0 FP — External Affairs Intern (Disney)
    'project controls',             // 1 gen, 0 FP — WDI Project Controls Planning Intern (Disney); Intel/Cat PCE dual-tag accept
    'content acquisition',          // 1 gen, 0 FP — Senior Content Acquisition Associate (Disney DTC); S&P/Spotify dual-tag accept
    'restaurant',                   // 1 gen, 0 FP — Restaurant Guest Service Manager (Disney Aulani); French Disney chef roles non-US
    'events coordinator',           // 3 gen, 0 FP — Events Coordinator (Exact Sciences, Jane Street, IDEXX)
    'coordinator, events',          // 1 gen, 0 FP — Coordinator, Events (FX) (Disney; reversed form)
    'event services',               // 1 gen, 0 FP — Event Services Coordinator Disney's Fairy Tale Weddings
    // TAG-11 C55: CACI operations/intelligence roles
    'exploitation specialist',      // 1 gen, 0 FP — Exploitation Specialist (CACI; intelligence exploitation/analysis for defense)
    'trainer intelligence',         // 1 gen, 0 FP — Trainer Intelligence (CACI; Special Forces MI instructor; GEOINT/SIGINT/OSINT training)
    'real-time operations controller', // 1 gen, 0 FP — Real-Time Operations Controller (CACI; 24x7 satellite ground system monitoring/ops)
    'aoc operations',               // 1 gen, 0 FP — AOC Operations SME (CACI; Air Operations Center mission/C2 systems operations)
    'resource management professional', // 1 gen, 0 FP — Resource Management Professional (CACI; defense program resource/workforce management)
    'program planning specialist',  // 1 gen, 0 FP — Program Planning Specialist (CACI; defense program planning/scheduling)
    'military operations and intelligence', // 1 gen, 0 FP — Military Operations and Intelligence Specialist (CACI; NAVWAR PNT intelligence analyst)
    'crisis operations response',   // 1 gen, 0 FP — Crisis Operations Response Advisor (CACI; DoD crisis action planning/CCDR support)
    'bambara linguist',             // 1 gen, 0 FP — French & Bambara Linguist (CACI; TS/SCI government linguistics; extends linguist series)
    'francophone arabic',           // 1 gen, 0 FP — Franco-Arab/Francophone Arabic Speaker (CACI; TS/SCI government linguistics)
    // TAG-11 C56: Elanco operations roles
    'audit coordinator',            // 1 gen, 0 FP — Audit Coordinator/ Administrator (Elanco; corporate audit lifecycle/admin coordination for CAS team)
    // TAG-11 C57: RE/SPEC operations roles
    'agilist',                      // 1 gen, 0 FP — Principle Agilist (RE/SPEC; SAFe/Lean-Agile enterprise coaching role)
  ];
  if (operationsKeywords.some(kw => title.includes(kw))) {
    pushTag('operations', findMatch(operationsKeywords, title), 'title');
  }

  // Legal domain (title-only)
  // Guard: isComplianceEngineer blocks 'Compliance Engineer', 'NERC Compliance Engineer',
  // 'Air Quality & Compliance Engineer', etc. — those are hardware/software, not legal.
  const legalKeywords = [
    'paralegal', 'legal counsel', 'commercial counsel', 'corporate counsel',
    'litigation counsel', 'regulatory counsel', 'privacy counsel',
    'compliance analyst', 'legal analyst', 'litigation paralegal',
    'contracts counsel', 'employment counsel',
 // GENERAL-CLASSIFICATION additions — +62 verified from live pool):
    'attorney',              // trial attorney, corporate attorney, etc.
    'compliance officer',    // compliance officer roles (4 hits — all legitimate)
    'compliance specialist', // compliance specialist roles (10 hits — all legitimate)
    'regulatory affairs',    // regulatory affairs specialist (9 hits — safe phrase)
    'regulatory specialist', // regulatory specialist titles
    'legal assistant',       // legal support roles
    'contracts specialist',  // contract management roles
    'contracts administrator',  // 7 hits — contract admin roles (defense, enterprise)
    'contract administrator',   // 10 hits — singular form
    'general counsel',          // 30 hits — in-house legal counsel
    'legal engineer',           // 4 hits — legal/product specialist roles (Thomson Reuters)
    'contracts analyst',        // 2 hits — contract analysis/management
    'legal intern',             // 4 gen — legal internship roles
    'contract specialist',      // 1 gen — contract management specialists
    'contracts coordinator',    // 1 gen — contract coordination
    'government affairs',       // 4 gen — government affairs/relations
    'law clerk',                // 2 gen — legal clerks (CACI defense)
    'content policy',           // 1 gen, 0 FP — content policy/moderation (Netflix)
    'case reviewer',            // 1 gen, 0 FP — case review (CACI defense)
    'federal affairs',          // 1 gen, 0 FP — government/federal affairs
    'grc team',                 // 2 gen, 0 FP — governance risk compliance
    'patent agent',             // 1 gen, 0 FP — patent agent
    'tax litigation',            // 1 gen, 0 FP — tax litigation reporter
    'legal reporter',            // 1 gen, 0 FP — legal reporter
    'tax law analyst',           // 1 gen, 0 FP — tax law analyst
    'claims law firm',          // 1 gen, 0 FP — claims law firm analyst (AIG)
    'regulatory policy',        // 1 gen, 0 FP — regulatory policy (Coinbase)
    'license compliance',       // 1 gen, 0 FP — license compliance (Autodesk)
    'federal defense lobbyist',      // 1 gen, 0 FP — defense lobbying
    'business affairs',             // 1 gen, 0 FP — Business Affairs Analyst (Disney media)
    'rights management',            // 1 gen, 0 FP — Analyst Rights Management (Disney DTC)
    'e-discovery project',          // 1 gen, 0 FP — E-Discovery Project Supervisor (CACI, ATS: Project Mgmt)
    'coordinator, contracts',       // 1 gen, 0 FP — Coordinator, Contracts (NBCUniversal; contracts compliance/invoice processing)
  ];
  // TAG-9: bare 'counsel' uses word-boundary — 'counselor' is a healthcare keyword,
  // includes('counsel') would match it. \bcounsel\b does not match 'counselor'.
  const counselRegex = /\bcounsel\b/i;
  const isComplianceEngineer = /\b(compliance engineer|compliance engineering)\b/i.test(title);
  if (!isComplianceEngineer && (legalKeywords.some(kw => title.includes(kw)) || counselRegex.test(job.title || ''))) {
    const legalMatch = findMatch(legalKeywords, title) || (counselRegex.test(job.title || '') ? 'counsel regex' : null);
    pushTag('legal', legalMatch, 'title');
  }

  // HR domain (title-only)
  const hrKeywords = [
    'recruiting coordinator', 'hr coordinator', 'hr analyst',
    'people operations', 'talent acquisition', 'human resources coordinator',
    'hr business partner', 'hris analyst',
 // GENERAL-CLASSIFICATION additions — +125 verified from live pool):
    'human resources',       // human resources specialist/generalist/manager
    'recruiter',             // technical recruiter, recruiter, founding recruiter
    'talent specialist',     // talent management specialist
    'staffing coordinator',  // staffing/scheduling coordinator
    // domain-accuracy audit: removed 'executive assistant' and 'administrative assistant'.
    // 188 jobs (31% of hr domain) were EAs/admins in non-HR departments (People, G&A, Admin).
    // EA to CEO/CRO is an ops/admin role, not HR. True HR roles classify via 'human resources',
    // 'recruiting', 'hr coordinator', etc. — those keywords remain and are sufficient.
    'instructional designer',// 11 hits — L&D/training design (HR function)
    'hr business partner',   // HR-specific form (bare 'business partner' FPs on 'Finance Business Partner')
    'training specialist',   // 10 gen — L&D/corporate training
    'early childhood',       // 2 gen — early childhood education teachers
    'training coordinator',  // 2 gen — training coordination
    'learning & development', 'learning and development', // 3 gen — L&D partners
    'talent attraction',     // 1 gen, 0 FP — talent sourcing/attraction
    'hr technology',         // 1 gen, 0 FP — HR tech/HRIS roles
    'accommodations consultant', // 1 gen, 0 FP — ADA/disability accommodations
    'cyber human capital',       // 1 gen, 0 FP — cyber workforce HR strategy
    'disability support',        // 1 gen, 0 FP — disability support specialist
    'hr assistant',              // 1 gen, 0 FP — HR assistant
  
    'team effectiveness',            // 1 gen, 0 FP — team effectiveness solutions
    'hr partner',                    // 1 gen, 0 FP — HR partner
    'associate relations investigator', // 1 gen, 0 FP — associate relations (Capital One)
    'hr generalist',                 // 2 gen, 0 FP — HR generalist
    'leave specialist',              // 2 gen, 0 FP — leave of absence specialist
    'talent strategy',              // 1 gen, 0 FP — ABC News Talent Strategy & Dev Intern (Disney)
    'recruitment coordinator',      // 1 gen, 0 FP — Recruitment Coordinator Disney Cruise Line
    'restrictions & accommodations', // 1 gen, 0 FP — Case Advocate Restrictions & Accommodations (Disney)
    'hr communications',            // 1 gen, 0 FP — AD HR Communications (AbbVie)
    'bhr operations',               // 1 gen, 0 FP — AD BHR Operations Acquisitions & Integration (AbbVie business HR)
    'benefits coordinator',         // 1 gen, 0 FP — Benefits Coordinator (SpaceX)
    'employee relations',           // 4 gen, 0 FP — Employee Relations Partner (Intuitive ×2), Employee Relations (ER) Specialist (Medtronic), Employee Relations Business Partner (Snap)
    'accommodations',               // 2 gen, 0 FP — Specialist, Accommodations (NBCUniversal; reasonable accommodation/ADA process), Global Benefits & Accommodations Intern (Proofpoint)
    'credit college',               // 1 gen, 0 FP — Principal Associate - Learning Consultant- Credit College (Capital One; enterprise L&D for credit/banking education)
    'recruiting lead',              // 1 gen, 0 FP — Principal Associate Recruiting Lead - Students And Grads (Capital One; campus/early-career recruiting)
    'hr delivery',                  // 1 gen, 0 FP — HR Delivery Associate -S&G Analyst Programs (Capital One; HR delivery for students & grads programs)
    // TAG-11 C54: Disney/cross-company HR
    'people and culture',           // 5 gen, 0 FP — modern HR dept name (Guidehouse, Rocket Lab, Zayo, Logitech, Morningstar)
    'people & culture',             // covers ampersand form in titles (Disney, WBD, Baker Hughes)
    // C58: HR keyword gaps
    'people partner',             // 2 gen — modern HR business partner title
  ];
  if (hrKeywords.some(kw => title.includes(kw))) {
    pushTag('hr', findMatch(hrKeywords, title), 'title');
  }

  // Product domain
  const productKeywords = [
    'product manager', 'product designer', 'ux designer',
    'ui designer', 'user experience', 'product owner', 'product marketing',
    // INTERN-1a Wave 2:
    'ux design', 'ux research', 'ux researcher', 'ui/ux',
    'industrial design', 'content design', 'experience design',
    'web experience design', 'product analytics', 'technical ux', 'game design',
    'product design intern',     // 7 hits — product design internship roles
    'digital product',           // 8 gen, 71% spec — digital product management
    'technical product',         // 5 gen, 86% spec — technical product management
    'animator',                  // 5 gen — animation roles (DreamWorks/NBCUniversal)
    'lighting artist',           // 1 gen — VFX/game lighting artists
    'compositor',                // 1 gen — VFX compositing artists
    'product management',        // 20 gen — product management roles
    'product coordinator',       // 1 gen, 0 FP — product coordinator
    'cx researcher',             // 1 gen, 0 FP — CX research & info design (Trimble)
    // TAG-11 C54: Disney product
    'product mgr',               // 1 gen, 0 FP — Associate Product Mgr (PH) (Disney WDI; abbreviation of 'product manager')
  ];
  if (productKeywords.some(kw => title.includes(kw))) {
    pushTag('product', findMatch(productKeywords, title), 'title');
  }

 // Retail domain (title-only — GENERAL-CLASSIFICATION new domain,
  // ~1,241 US+general jobs verified from live pool.
  // 'team member' is very broad but in-scope: Walmart/Target/DashMart crew roles are correctly retail.
  // 'seasonal:' with colon catches Target "Seasonal: General Merchandise (Stocking)" format.
  // Guard: isRetailBanking excludes "Retail Personal Banker", "Retail Loan Originator" — those are finance.
  const retailKeywords = [
    'cashier',               // #1 retail job title (~300+ hits)
    'store associate',       // big box retail associate
    'retail',                // retail specialist, retail sales, retail associate
    'merchandis',            // merchandiser, merchandising (prefix match)
    'stocker',               // grocery/retail stocker
    'loader',                // Lowe's/HD loader/cart associate
    'cart associate',        // cart retrieval crew
    'stocking',              // overnight stocking, inbound stocking
    'crew member',           // fast food/restaurant crew
    'team member',           // Walmart/Target/Sam's Club team member
    'barista',               // Starbucks/coffee shop
    'seasonal:',             // Target seasonal format "Seasonal: [role] (Stocking)"
    'backroom associate',    // Target/Walmart backroom
    'overnight inbound',     // Target overnight inbound freight
 // TAG-1 G1 expansion: 347+90 T-Mobile retail roles
    'mobile associate',      // T-Mobile in-store retail (347 hits)
    'specialty representative', // T-Mobile in-store specialty (90 hits)
    'personal shopper',      // 22 hits — Walmart/Target personal shopper
    'member specialist',     // 30 hits — Sam's Club/Walmart member specialist
    'sales floor',           // 43 hits — Lowe's department supervisors
    'asset protection',      // 17 hits — Lowe's/Walmart loss prevention
    'back-end dept supervisor', // 2 gen, 0 FP — store department supervision (Lowe's)
    'seasonal summer hiring',   // 1 gen, 0 FP — seasonal retail hiring (WBD Harry Potter)
    'back end clerk',            // 4 gen — Lowe's back-end store clerks
    'margaritaville',            // 1 gen, 0 FP — Assistant GM - Margaritaville (NBCUniversal)
  ];
  const isRetailBanking = /\b(banker|banking|loan originator|mortgage|lender)\b/i.test(title);
  if (!isRetailBanking && retailKeywords.some(kw => title.includes(kw))) {
    pushTag('retail', findMatch(retailKeywords, title), 'title');
  }

 // Manufacturing domain (title-only — GENERAL-CLASSIFICATION new domain,
  // ~1,004 US+general jobs verified from live pool.
  // Was causing 132 hardware-only misroutes. Manufacturing engineers → manufacturing domain.
  // 'assembly' is safe: all hits are assembly tech/technician/operator titles, no legislative false positives.
  const manufacturingKeywords = [
 'manufacturing engineer', 'manufacturing engineering', //: moved from hardware — 132 misroutes fixed
    'machine operator',          // CNC/machine operator
    'production operator',       // production floor operator
    'assembler',                 // assembly line worker
    'assembly',                  // assembly technician, electronics assembly
    'welder',                    // welding/weld technician
    'machinist',                 // CNC machinist
    'production associate',      // production floor associate
    'production technician',     // production tech
    'material handler',          // materials/warehouse handling on production floor
 'maintenance technician', // TAXONOMY-AUDIT-1: 203 jobs in general
 // TAG-1 G1 expansion: test/engineering technician roles on production floor
    'test technician',           // 68 hits — RF/optical/production test (FLIR, RTX, GE)
    'engineering technician',    // 47 hits — manufacturing/production engineering
    'manufacturing operator',    // 35 hits — factory floor operators
    'manufacturing technician',  // 50 hits — manufacturing production techs
    'fabricat',                  // 38 hits — fabricator/fabrication (prefix match)
    'wastewater',                // 20 hits — wastewater operator/technician (Veolia, SpaceX)
    'manufacturing supervisor',  // 16 hits — production floor supervisors
    'production supervisor',     // 43 hits — production floor supervisors
    'painter',                   // 18 hits — industrial/automotive/facility painters
    'production planner',        // 10 hits — production planning/scheduling
    'cnc programmer',            // 5 hits — CNC machine programming
    'mold designer',             // 1 hit — injection mold design
    'metrologist',               // 2 hits — precision measurement roles
    'industrial maintenance',    // 3 hits — industrial maintenance technicians
    'cycle counter',             // 3 hits — inventory cycle counting (manufacturing floor)
    'quality technician',        // 5 hits — QC/QA floor technicians
    'production specialist',     // 4 hits — production floor specialists
    'maintenance mechanic',      // 4 gen — compound form safe (bare 'mechanic' rejected Phase 1)
    'maintenance supervisor',    // 5 gen — maintenance floor supervisors
    'cnc operator',              // 4 gen — CNC machine operators
    'materials planner',         // 4 gen — materials/production planning
    'product acceptance',        // 4 gen — product acceptance/QA
    'material support',          // 4 gen — material handling support
    'peripheral operator',       // 5 gen — peripheral/auxiliary equipment operators
    'paint prep',                // 3 gen — paint preparation (Oshkosh)
    'paint tech',                // 3 gen — paint technician
    'industrial hygienist',      // 2 gen — workplace safety/hygiene
    'production coach',          // 2 gen — production floor supervisors (Moog)
    'production equipment',      // 8 gen — production equipment technicians (Broadridge)
    'quality assurance',         // 12 gen — QA supervisors/reviewers (Abbott, Biogen)
    'mechanical repair',         // 2 gen — mechanical repair technicians
    'deburr',                    // 6 gen — deburring technicians (Jabil)
    'iron technician',           // 2 gen — iron/metalwork technicians
    'generator tester',          // 2 gen — generator testing
    'apprentice',                // 11 gen — trade apprenticeships
    'finisher',                  // 2 gen — manufacturing finishers
    'ndt technician',            // 4 gen — non-destructive testing techs (was desc phrase only)
    'tool & die', 'tool and die', // 2 gen — tool & die engineering/making
    'ndt tech',                  // 1 gen — short form of NDT technician
    'nc programmer',             // 1 gen — NC machine programming
    'smt technician',            // 3 gen — surface mount technology
    'insulator',                 // 1 gen — insulation installers
    'production support',        // 2 gen — production support technicians
    'production coordinator',    // 6 gen — production coordination
    'maintenance tech',          // 6 gen — short form of maintenance technician
    'automotive detailer',       // 12 gen — vehicle detailing (Copart)
    'mechanical associate',      // 12 gen — mechanical repair associates (Copart)
    'modification mechanic',     // 3 gen, 0 FP — aircraft modification mechanics (Boeing)
    'wrapper',                   // 2 gen, 0 FP — packaging/wrapping roles (JCI)
    'glass seal plater',         // 1 gen, 0 FP — glass seal plating (FLIR)
    'launch pad technician',     // 1 gen, 0 FP — launch pad ground ops (SpaceX)
    'tester i',                  // 3 gen, 0 FP — manufacturing tester level I
    'plumber',                   // 2 gen, 0 FP — plumbing roles (Oshkosh airports)
    'jetway laborer',            // 1 gen, 0 FP — airport jetway labor (Oshkosh)
    'bag jammer',                // 1 gen, 0 FP — airport baggage handling (Oshkosh)
    'paint touch',               // 1 gen, 0 FP — paint touch-up/detailing
    'graphics application',      // 1 gen, 0 FP — vehicle graphics application
    'machine tool services',     // 1 gen, 0 FP — machine tool services supervisor
    'production worker',         // 1 gen, 0 FP — production worker
    'facilities operator',       // 2 gen, 0 FP — facilities operator
    'brake component',           // 1 gen, 0 FP — brake component operator
    'production integration',    // 1 gen, 0 FP — production integration specialist
    'special process auditor',   // 1 gen, 0 FP — special process auditing
    'supervisor, installations', // 1 gen, 0 FP — installations supervisor
    'honing set-up',                // 1 gen, 0 FP — honing setup (Bosch)
    'electrical journeyperson',     // 2 gen, 0 FP — electrical journeyperson (GM)
    'mechanical journeyperson',     // 1 gen, 0 FP — millwright journeyperson (GM)
    'metrology specialist',         // 1 gen, 0 FP — metrology specialist (SpaceX)
    'pipefitter',                   // 1 gen, 0 FP — pipefitter (FLIR)
    'component inspection',         // 1 gen, 0 FP — component inspection (FLIR)
    'lab equipment control',        // 1 gen, 0 FP — lab equipment diagnostics (FLIR)
    'in house service',             // 1 gen, 0 FP — in-house service/repair (FLIR)
    'manufacturing program',        // 1 gen, 0 FP — manufacturing program mgr (FLIR)

    'composite rework',          // 1 gen, 0 FP — composite rework/repair
    'product repair',            // 2 gen, 0 FP — product repair/modification
    'flight operations mechanic', // 2 gen, 0 FP — flight ops mechanic
    'numerical control programmer', // 1 gen, 0 FP — NC programming
    'munitions mechanic',        // 1 gen, 0 FP — munitions mechanic
    'plating line',              // 1 gen, 0 FP — plating line technician
    'antisense',                 // 1 gen, 0 FP — antisense oligonucleotide manufacturing
    'maintenance operator',      // 1 gen, 0 FP — maintenance operator
    'pyrometry technician',      // 1 gen, 0 FP — pyrometry (Moog)
    'mfg maint tech',            // 2 gen, 0 FP — mfg maintenance technician
    'multilayer',                // 1 gen, 0 FP — multilayer process specialist (Northrop)
    'manufacturing operations trainer', // 1 gen, 0 FP — mfg ops trainer (Generac)
    'automotive offline',            // 2 gen, 0 FP — automotive offline technician (Oshkosh)
    'clutch balancer',           // 1 gen, 0 FP — clutch balancer tech (Polaris)
    'manufacturing excellence',  // 1 gen, 0 FP — manufacturing excellence program
    'recon mechanic',            // 1 gen, 0 FP — recon mechanic (Copart)
    'paint hanger',              // 2 gen, 0 FP — paint hanger (Generac)
    'patternmaker',              // 1 gen, 0 FP — patternmaker (Caterpillar)
    'material review',           // 1 gen, 0 FP — Quality Production Spclst MRB (Boeing)
    'quality production spclst', // 1 gen, 0 FP — Quality Production Specialist (Boeing)
    'support integration specialist', // 1 gen, 0 FP — Support Integration Specialist (Boeing)
    'supv manufacturing',            // 1 gen, 0 FP — Supv Manufacturing (RTX, abbreviated supervisor)
    'clinical supply line',          // 1 gen, 0 FP — Operator Clinical Supply Line (AbbVie cGMP packaging)
    'fill/finish technician',        // 1 gen, 0 FP — Fill/Finish Technician (AbbVie biologics manufacturing)
    'technical process specialist',  // 1 gen, 0 FP — Technical Process Specialist 3rd shift (Bosch)
    'case picking',                  // 1 gen, 0 FP — Full Case Picking warehouse (Bosch)
    'product quality auditor',       // 1 gen, 0 FP — Product Quality Auditor HVAC (Bosch)
    'material planning',             // 1 gen, 0 FP — Material Planning Intern (Bosch)
    'coatings technician',           // 1 gen, 0 FP — Paint & Coatings Technician (SpaceX)
    'foundry operator',              // 2 gen, 0 FP — Heavy Foundry Operator, Experienced Foundry Operators (Caterpillar Mapleton CMO)
    'molding specialist',            // 1 gen, 0 FP — Molding Specialist 2nd/3rd Shift (Caterpillar Mapleton CMO)
    'paint team lead',               // 1 gen, 0 FP — Paint Team Lead 1st Shift (Caterpillar) [Career Area: Operations]
    'industrial repair technician',  // 1 gen, 0 FP — Industrial Repair Technician (Caterpillar) [Career Area: Operations]
    'inspection quality auditor',    // 1 gen, 0 FP — Inspection Quality Auditor - CMM (Caterpillar) [Career Area: Operations; CMM = coordinate measuring machine]
    'utilities repair technician',   // 1 gen, 0 FP — Utilities Repair Technician 2nd Shift (Caterpillar) [Career Area: Operations]
    'mining technical representative', // 1 gen, 0 FP — Seniour Mining Technical Representative (Caterpillar) [mining tech = manufacturing/heavy equipment domain]
    'advanced manufacturing technical', // 1 gen, 0 FP — Advanced Manufacturing Technical Specialist (Guidehouse)
    'mes associate',                // 1 gen, 0 FP — MES Associate 2 (Abbott; MES = Manufacturing Execution System)
    'technical engineering function', // 1 gen, 0 FP — Technical Engineering Function (TEF) Summer Intern (Bosch; manufacturing/engineering rotation program)
    'engineer process',            // 2 gen, 0 FP — Engineer Process level 2 + Engineer Process 1/2 (NG; inverted WD title format for manufacturing process engineers)
    'deployable aircraft',         // 1 gen, 0 FP — Deployable Aircraft Low Observable Mechanic 3 (NG; stealth/LO coating mechanics)
    'welding technician',          // 2 gen, 0 FP — Welding Technician 1st Shift (RTX), Airport Services Welding Technician (Oshkosh) ['welder' kw misses this form]
    'foundry equipment',           // 1 gen, 0 FP — Foundry Equipment Operator 1st Shift (RTX; casting/foundry operations)
    // TAG-11 C55: CACI manufacturing roles
    'cmm technician',              // 1 gen, 0 FP — CMM Technician (CACI; Coordinate Measuring Machine technician for precision manufacturing quality inspection)
    // TAG-11 C56: Elanco manufacturing roles
    'specialist - manufacturing operations', // 1 gen, 0 FP — Specialist - Manufacturing Operations (Elanco; pharma manufacturing ops specialist)
    'advisor-manufacturing',        // 1 gen, 0 FP — Advisor-Manufacturing (Elanco; manufacturing advisory/technical role; dash-separated format)
    'supervisor - manufacturing operations', // 1 gen, 0 FP — Supervisor - Manufacturing Operations (Elanco; pharma mfg supervisor)
    'product recovery',             // 1 gen, 0 FP — Process Operator – Product Recovery (Elanco; API product recovery operations)
    'distribution, packaging',      // 1 gen, 0 FP — Operator - Distribution, Packaging & Labeling (Elanco; vaccine packaging/labeling). Comma-guard avoids 'distribution center' false-positives.
    'process operator - packaging', // 1 gen, 0 FP — Process Operator - Packaging (Elanco; oral solid dose packaging for companion animal products)
    // TAG-PRECISION-14: high-impact manufacturing keywords
    'quality inspector',            // 27 gen — production floor QC inspectors
    'quality manager',              // 21 gen — QA/QC management
    'process technician',           // 15 gen — process/production technicians (Applied Materials, etc.)
    'manufacturing manager',        // 8 gen — manufacturing floor management
  ];
  // EHS uses word-boundary regex — 'ehs' substring appears in 'FranceHS', 'EHSS'
  const ehsRegex = /\behs\b/i;
  if (manufacturingKeywords.some(kw => title.includes(kw)) || ehsRegex.test(job.title || '')) {
    const mfgMatch = findMatch(manufacturingKeywords, title) || (ehsRegex.test(job.title || '') ? 'ehs regex' : null);
    pushTag('manufacturing', mfgMatch, 'title');
  }

 // Logistics domain (title-only — GENERAL-CLASSIFICATION new domain,
  // ~426 US+general jobs verified from live pool (409 core + 17 'distribution center' phrase).
  // NOTE: bare 'distribution' NOT added — "Distribution Engineer" (utility/electrical) is hardware domain.
  // NOTE: bare 'shipping' NOT added — "Shipping Coordinator" is already ops-adjacent and low volume.
  // 'logistics' kept here because 'logistics analyst' is already captured by operations domain keywords —
  //   remaining hits are warehouse/supply-chain workers, not analyst roles.
  const logisticsKeywords = [
 'fulfillment associate', //: moved from operationsKeywords — 225 Lowe's/warehouse jobs now correctly logistics
 'fulfillment team lead', //: moved from operationsKeywords — same reason
    'warehouse',             // warehouse worker/associate/supervisor
    'forklift',              // forklift operator/driver
    'cdl',                   // CDL driver (commercial driver's license)
    'delivery driver',       // last-mile delivery
    'freight',               // freight handler/clerk
    'logistics coordinator', 'logistics specialist', 'logistics clerk',  // specific logistics roles
    'logistics associate', 'logistics supervisor', 'logistics technician', // (bare 'logistics' NOT added —
    // 'Logistics Engineer' and 'Logistics Automation Engineer' are hardware/software, not logistics)
    'truck driver',          // OTR/regional truck driver
    'distribution center',   // distribution center worker/supervisor (phrase — safe, no hw FP)
 // TAG-1 G1 expansion: supply chain specialist/coordinator
    'supply chain specialist',   // supply chain roles not caught by operations 'supply chain analyst'
    'supply chain coordinator',  // coordination roles
    'inventory associate',       // 17 hits — inventory/warehouse associate
    'dispatcher',                // 8 hits — logistics/fleet dispatch roles
    'distribution specialist',   // 2 hits — distribution/logistics specialists
    'shipping clerk',            // 1 gen — shipping/receiving clerks
    'loadmaster',                // 1 gen — aircraft loadmasters
    'logistic coordinator',      // 1 gen — singular form (had 'logistics coordinator')
    'shipping associate',        // 5 gen — shipping/receiving associates
    'shuttle driver',            // 2 gen — shuttle/transport drivers
  
    'dispatching clerk',             // 1 gen, 0 FP — dispatching clerk
    'logistics administration',      // 1 gen, 0 FP — logistics administration
    'material transfer driver',     // 1 gen, 0 FP — material transfer driver

    'packaging & shipping',          // 1 gen, 0 FP — packaging/shipping planner
    'logistics integration cell',    // 1 gen, 0 FP — logistics integration cell (RTX)
    'ltl/parcel',                    // 1 gen, 0 FP — LTL/Parcel Team Lead (Bosch)
    'logistics materials',           // 1 gen, 0 FP — Logistics Materials Intern/Co-Op (Bosch)
    'npi logistics',                 // 1 gen, 0 FP — NPI Logistics Engineer (Caterpillar) [new product introduction logistics]
    'distribution technician',       // 1 gen, 0 FP — Distribution Technician-1st Shift (Caterpillar)
    'sca stock',                     // 1 gen, 0 FP — SCA Stock Clerk (NG; govt contract stock/inventory clerk)
    // TAG-11 C54: Disney/cross-company logistics
    'expeditor',                     // 2 gen, 0 FP — Expeditor (Disney DCL, NG Manufacturing Expeditor); supply chain coordination
    'inventory coordinator',         // 2 gen, 0 FP — Administrative & Inventory Coordinator (Disney), Inventory Coordinator (ResMed)
  ];
  if (logisticsKeywords.some(kw => title.includes(kw))) {
    pushTag('logistics', findMatch(logisticsKeywords, title), 'title');
  }

  // TAG-SELF-3: Cache keyword arrays for per-keyword health monitoring.
  if (!_keywordMap) {
    _keywordMap = {
      software: softwareKeywords,
      ai: aiKeywords,
      data_science: dataScienceKeywords,
      hardware: hardwareKeywords,
      healthcare: healthcareExact,
      finance: financeKeywords,
      sales: salesKeywords,
      marketing: marketingKeywords,
      operations: operationsKeywords,
      legal: legalKeywords,
      hr: hrKeywords,
      product: productKeywords,
      retail: retailKeywords,
      manufacturing: manufacturingKeywords,
      logistics: logisticsKeywords,
    };
  }

  // TAG-7: Description fallback for general-tagged jobs.
  // WD/SR descriptions injected by aggregator Step 4c (from enrichment sidecar).
  // GH/Lever/Ashby have inline descriptions from their API responses.
  // Only fires when: (1) no title keyword/O*NET match, (2) description non-empty.
  // Tier 1 (highPrecision): phrases with >80% precision — 1 match suffices.
  // Tier 2 (standard): phrases with <80% precision — 2+ matches required.
  // Precision = % of US classified jobs containing the phrase that are in the intended domain.
 // Measured across 22,513 US jobs with descriptions analysis).
  if (tags.length === 0 && description.length > 100) {
    const cleanDesc = description.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase();

    // Tier 1: High-precision phrases (>80% precision). 1 match = classify.
    const highPrecision = [
      { domain: 'hardware', phrases: ['thermal design', 'circuit design', 'fpga', 'pcb', 'signal integrity', 'oscilloscope', 'mechanical design'] },
      { domain: 'software', phrases: ['code review', 'ci/cd', 'api design', 'microservice', 'deployment pipeline', 'kubernetes', 'docker', 'terraform', 'containerization', 'pull request', 'load balancer', 'codebase', 'automated testing', 'encryption'] },
      { domain: 'data_science', phrases: ['feature engineering'] },
      { domain: 'finance', phrases: ['financial statements', 'fund administration', 'gaap', 'ifrs', 'general ledger', 'journal entry', 'month-end close', 'fund accounting', 'balance sheet', 'income statement', 'wealth management'] },
      { domain: 'healthcare', phrases: ['drug safety', 'vital signs', 'informed consent', 'blood draw', 'nursing assessment', 'clinical operations', 'medical affairs'] },
      { domain: 'manufacturing', phrases: ['machine operation'] },
      { domain: 'sales', phrases: ['sales quota', 'sales pipeline', 'revenue target'] },
      { domain: 'legal', phrases: ['bar admission', 'legal counsel'] },
      { domain: 'retail', phrases: ['store operations'] },
    ];

    // Tier 2: Standard phrases (<80% precision). 2+ matches required.
    const standardPhrases = [
      { domain: 'hardware', phrases: ['simulation', 'commissioning', 'equipment calibration', 'test systems', 'embedded system', 'power supply', 'schematic',
        'solidworks', 'autocad', 'electrical engineering', 'failure analysis', 'bill of materials', 'prototyping', 'wiring diagram',
        'semiconductor', 'wafer', 'silicon', 'plc'] },
      { domain: 'software', phrases: ['source code', 'database design', 'incident response', 'version control', 'agile development', 'sprint planning', 'unit test',
        'programming language', 'technical debt',
        'endpoint', 'virtualization', 'firewall', 'test automation', 'regression test', 'dns'] },
      { domain: 'data_science', phrases: ['machine learning', 'statistical model', 'data pipeline', 'model training', 'a/b test', 'data warehouse', 'etl process', 'predictive model'] },
      { domain: 'finance', phrases: ['treasury', 'portfolio management', 'credit risk', 'financial reporting',
        'reconciliation', 'accounts payable', 'accounts receivable', 'internal controls',
        'investment management', 'asset management', 'fixed income', 'capital markets',
        'real estate', 'shareholder', 'budgeting', 'money laundering'] },
      { domain: 'healthcare', phrases: ['patient care', 'clinical trial', 'hipaa', 'therapeutic area', 'medical device', 'pharma', 'clinical research', 'fda', 'healthcare provider',
        'triage', 'infection control', 'sterile', 'specimen', 'inpatient', 'outpatient',
        'patient outcomes', 'regulatory affairs', 'drug development', 'therapeutics'] },
      { domain: 'manufacturing', phrases: ['production floor', 'assembly line', 'quality control', 'manufacturing process', 'cnc', 'lean manufacturing', 'production schedule', 'material handling',
        'work instruction', 'tooling', 'fixtures', 'preventive maintenance', 'iso 9001',
        'production line', 'clean room', 'gmp', 'good manufacturing',
        'cleanroom', 'machining', 'ndt', 'defect analysis'] },
      { domain: 'operations', phrases: ['project management', 'inventory management', 'operational efficiency', 'process improvement', 'vendor management', 'supply chain', 'fulfillment', 'service level',
        'facility security', 'classified information', 'industrial security',
        'procurement', 'property management', 'compliance program'] },
      { domain: 'sales', phrases: ['territory management', 'customer acquisition', 'business development', 'account management', 'product demonstration',
        'field-based'] },
      { domain: 'hr', phrases: ['employee relations', 'talent management', 'onboarding', 'performance review', 'compensation and benefits', 'workforce planning', 'learning and development'] },
      { domain: 'legal', phrases: ['litigation', 'regulatory compliance', 'contract negotiation', 'intellectual property', 'corporate governance'] },
      { domain: 'marketing', phrases: ['brand strategy', 'content marketing', 'digital marketing', 'market research', 'campaign management', 'social media strategy', 'marketing analytics'] },
      { domain: 'retail', phrases: ['merchandising', 'product categories', 'store manager'] },
    ];

    // Tier 1: single high-precision match
    for (const { domain, phrases } of highPrecision) {
      const match = phrases.find(p => cleanDesc.includes(p));
      if (match) {
        pushTag(domain, '(desc-hp: ' + match + ')', 'description-fallback');
        break;
      }
    }

    // Tier 2: 2+ standard phrase matches (only if Tier 1 didn't match)
    if (tags.length === 0) {
      for (const { domain, phrases } of standardPhrases) {
        const matches = phrases.filter(p => cleanDesc.includes(p));
        if (matches.length >= 2) {
          pushTag(domain, '(desc: ' + matches.slice(0, 2).join(' + ') + ')', 'description-fallback');
          break;
        }
      }
    }
  }

  // TAG-11 C47: Pre-O*NET civil engineering guard.
  // Titles with 'project engineer' + civil modifier were blocked from sw (isGuardedSwOnly) but
  // then fell through to O*NET which matched 'project engineer' -> hardware.
  // These are civil/structural/water resources project engineers (RE/SPEC, Veolia) — should be general.
  // Guard: 'project engineer' as title anchor + civil-domain modifier → push general, skip O*NET.
  if (tags.length === 0 && title.includes('project engineer') && isCivilProjectEngineer) {
    pushTag('general', null, null);
  }

  // O*NET maps 'executive assistant' → operations (SOC 43-6011: Executive Secretaries).
  // But EAs are not operations roles — they're administrative support. After removing ea/aa from
  // hrKeywords, these 101 jobs were falling to O*NET and getting tagged operations.
  // Correct classification: general (cross-functional admin support, no domain signal).
  const isExecAdminAssistant = /\b(executive assistant|administrative assistant|admin assistant)\b/i.test(title);
  if (tags.length === 0 && isExecAdminAssistant) {
    pushTag('general', null, null);
  }

  // ENR-8: Pre-O*NET Intuitive Surgical clinical/QC guard.
  // 'Clinical Application Engineer' (singular) misses the hw keyword 'applications engineer'
  // but O*NET matches 'application engineer' → hardware. These are clinical training/support
  // roles, not hardware engineering. Guard fires before O*NET to push general instead.
  if (tags.length === 0 && isIntuitiveClinicalFP) {
    pushTag('general', null, null);
  }

  // TAG-PRECISION-8: Pre-O*NET systems analyst guard.
  // 'systems analyst' blocked by isGuardedSwOnly for business/HRIS/financial context,
  // but O*NET maps 'systems analyst' → software (SOC 15-1299.08). O*NET overrides the guard.
  // Same pattern as TAG-11 C47 civil engineering guard.
  if (tags.length === 0 && title.includes('systems analyst') && isNonSwSystemsAnalyst) {
    pushTag('general', null, null);
  }

  // O*NET taxonomy fallback (unified): 28,486 title variants from O*NET v29.1.
  // 3+ word titles: substring matching (safe — long titles have few collisions).
  // 2-word titles: word-boundary regex (prevents "air technician" ← "Repair Technician").
  // Both word-indexed for fast candidate filtering.
 // Source: O*NET v29.1 (public domain, CC BY 4.0). See TAG_CLASSIFICATION_RESEARCH_.md.
  if (tags.length === 0) {
    // TAG-PRECISION-11: Pre-O*NET technician guard — "Technician" is never a hardware engineering
    // role. O*NET maps many technician titles to hardware (SOC 17-3024 "Electro-Mechanical and
    // Mechatronics Technologists and Technicians"). Block O*NET HW domain for technician-only titles.
    const isOnetTechFP = /\btechnicians?\b/i.test(title) &&
      !/\bengineer/i.test(title) && !/\bscientist\b/i.test(title);
    // TAG-KEYWORD-10: Pre-O*NET guard for removed keywords — O*NET maps "network engineer",
    // "systems administrator", and "service desk" to software. These are now handled by
    // title keywords (TAG-PRECISION-13) with appropriate guards, so this guard only blocks
    // O*NET fallback for titles that don't match any keyword.
    // TAG-KEYWORD-11: Extended to cover 'it service' and 'it systems' admin/AV/ops variants.
    const isOnetSwFP = (
      /\b(network engineer|systems? administrator|service desk|it services? (?:technician|manager|level|delivery|desk))\b/i.test(title) ||
      (/\bit systems\b/i.test(title) && /\b(administrator|a\/v|ops|operations|manager|supervisor)\b/i.test(title))
    ) && !/\b(software|developer|cloud|platform|site reliability|devops)\b/i.test(title);
    const titleWords = title.split(/\s+/).filter(w => w.length >= 4);

    // Pass 1: 3+ word substring matches (longest-first, pre-sorted)
    if (ONET.substringEntries.length > 0) {
      const candidates = new Set();
      for (const word of titleWords) {
        const indices = ONET.substringWordIndex.get(word);
        if (indices) indices.forEach(i => candidates.add(i));
      }
      for (const idx of [...candidates].sort((a, b) => a - b)) {
        const [onetTitle, domain] = ONET.substringEntries[idx];
        if (title.includes(onetTitle)) {
          if (isOnetTechFP && domain === 'hardware') continue;
          if (isOnetSwFP && domain === 'software') continue;
          pushTag(domain, '(onet: ' + onetTitle + ')', 'onet-fallback');
          break;
        }
      }
    }

    // Pass 2: 2-word regex matches (only if pass 1 didn't match)
    if (tags.length === 0 && ONET.regexEntries.length > 0) {
      for (const word of titleWords) {
        const indices = ONET.regexWordIndex.get(word);
        if (!indices) continue;
        for (const idx of indices) {
          const entry = ONET.regexEntries[idx];
          if (entry.re.test(title)) {
            if (isOnetTechFP && entry.domain === 'hardware') continue;
            if (isOnetSwFP && entry.domain === 'software') continue;
            pushTag(entry.domain, '(onet: ' + entry.title + ')', 'onet-fallback');
            break;
          }
        }
        if (tags.length > 0) break;
      }
    }
  }

 // Layer 5: Tenant-context fallback (TAG-10)
  // Claude-researched per-tenant defaults for verified single-domain companies.
  // Only fires when ALL other layers (dept, keywords, O*NET, desc-fallback) produce no match.
  if (tags.length === 0 && TENANT_DEFAULTS.size > 0) {
    const slug = (job.company_slug || '').toLowerCase();
    const defaultDomain = TENANT_DEFAULTS.get(slug);
    if (defaultDomain) {
      pushTag(defaultDomain, '(tenant: ' + slug + ')', 'tenant-context');
    }
  }

  // Default to general if still no matches
  if (tags.length === 0) {
    pushTag('general', null, null);
  }

  // Deduplicate domains — a job can match the same domain from multiple layers
  // (e.g., department rule + title keyword both → software). Debug matches
  // retain all records for traceability; only the domain array is deduped.
  const uniqueTags = [...new Set(tags)];

  if (debug) return { domains: uniqueTags, matches };
  return uniqueTags;
}

/**
 * US-only company slugs for Layer 2b location fallback.
 * Applied when no us tag yet AND job is not explicitly non-US.
 * NO bare-string restriction — fires for any location string (facility names, campus names, etc.).
 * ONLY slugs with ZERO confirmed non-US offices. NON_US blocklist still runs first.
 * Do NOT add any company with offices outside the US — use US_HQ_SLUGS instead.
 */
const US_HQ_ONLY_SLUGS = new Set([
  'wvu-medicine',            // WV health system — all WV/adjacent US facilities
  'banner-health',           // AZ health system — US-only
  'geisinger-health',        // PA health system — US-only
  "nationwide-children's",   // OH children's hospital — US-only
]);

/**
 * US-headquartered company slugs used for Layer 2 location fallback.
 * Only applied when Layer 1 (explicit location string) returns no US signal AND
 * the location string is an ambiguous bare value ('In-Office', 'Remote', 'N Locations').
 * These are companies where ANY office posting is plausibly US — US-only or near-US-only footprint.
 * Do NOT add multinational companies whose non-US offices post with bare location strings.
 */
const US_HQ_SLUGS = new Set([
  // Original entries
  'cloudflare',        // In-Office (37 interns, US-only HQ pattern)
  'geisinger-health',  // Work from Home (9 interns, US healthcare system)
  'caci',              // Remote (2 interns, US defense contractor)
  'voltus',            // Remote (2 interns, US energy startup)
  'supabase',          // Remote (1 intern, US startup)
  'safariai',          // Remote (1 intern, US startup)
  'f5',                // N Locations (4 interns, US networking company)
  'leidos',            // Remote/Teleworker US (5 interns, US defense contractor)
 // LOC-AUDIT-1 additions (2026-03-15 — verified US-only N-Location posters
  'wvu-medicine',           // N Locations — US health system (West Virginia)
  'banner-health',          // N Locations — US health system (Arizona)
  'pnc-financial',          // N Locations — US bank (Pittsburgh-HQ)
  'fidelity-investments',   // N Locations — US financial services
  'allstate',               // N Locations — US insurer (Northbrook IL)
  'general-motors',         // N Locations — US automaker (Detroit)
  'snap',                   // N Locations — US tech (Santa Monica)
  'ncino',                  // N Locations — US fintech (Wilmington NC)
  'workiva',                // N Locations — US SaaS (Ames IA)
  "nationwide-children's",  // N Locations — US children's hospital (Columbus OH)
  'elevance-health',        // N Locations — US health insurer (Indianapolis)
  'northrop-grumman',       // N Locations — US defense (Falls Church VA)
  'coreweave',              // N Locations — US cloud (Roseland NJ)
  'at&t',                   // N Locations — US telecom (Dallas)
  'draftkings',             // N Locations — US sports betting (Boston)
  'boeing',                 // N Locations — US aerospace (Arlington VA)
]);

/**
 * Non-US location indicators (city names, countries, regions)
 * Used to detect ATS jobs with non-US locations (ATS normalizer sets job.location
 * as a string but doesn't populate job.job_country, so is_us_only is unreliable for ATS)
 */
const NON_US_LOCATIONS = [
  // Countries
  'canada', 'mexico', 'ireland', 'united kingdom', 'uk', 'germany', 'france',
  'netherlands', 'india', 'singapore', 'japan', 'australia', 'brazil', 'spain',
  'sweden', 'denmark', 'norway', 'finland', 'switzerland', 'poland', 'czechia',
  'romania', 'argentina', 'chile', 'colombia', 'peru', 'israel', 'turkey',
  'south korea', 'china', 'taiwan', 'new zealand', 'south africa', 'portugal',
  'costa rica', 'saudi arabia', 'hungary', 'ukraine', 'egypt', 'nigeria',
  'pakistan', 'bangladesh', 'vietnam', 'indonesia', 'thailand', 'malaysia',
  'philippines', 'greece', 'italy', 'belgium', 'austria', 'czech republic',
  // Common non-US cities that appear in ATS feeds
  'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', // Canada
  'london', 'manchester', 'edinburgh', // UK
  'dublin', 'cork', // Ireland
  'berlin', 'munich', 'hamburg', // Germany
  'amsterdam', 'rotterdam', // Netherlands
  'bengaluru', 'bangalore', 'mumbai', 'hyderabad', 'pune', 'chennai', 'delhi', // India
  'singapore',
  'sydney', 'melbourne', 'brisbane', // Australia
  'tokyo', 'osaka', // Japan
  'mexico city', 'guadalajara', 'monterrey', // Mexico
  'paris', 'lyon', // France
  'stockholm', 'gothenburg', // Sweden
  'tel aviv', 'jerusalem', // Israel
  'zurich', 'geneva', // Switzerland
  'warsaw', 'krakow', // Poland
  'prague', // Czechia
  'bucharest', // Romania
  'madrid', 'barcelona', // Spain
  'lisbon', 'porto', // Portugal
  'budapest', 'debrecen', // Hungary
  'haifa', 'tel aviv', 'jerusalem', // Israel (tel aviv already above, kept for clarity)
  'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'chengdu', 'hangzhou', // China
  'dubai', 'abu dhabi', // UAE
  'moscow', 'saint petersburg', // Russia
  'cairo', // Egypt
  'nairobi', // Kenya
  'lagos', // Nigeria
  'johannesburg', 'cape town', // South Africa
  'bogota', // Colombia
  'lima', // Peru
  'santiago', // Chile
  'buenos aires', // Argentina
  'ho chi minh', 'hanoi', // Vietnam
  'jakarta', // Indonesia
  'bangkok', // Thailand
  'kuala lumpur', // Malaysia
  'manila', // Philippines
  'athens', // Greece
  'rome', 'milan', // Italy
  'brussels', 'antwerp', // Belgium
  'vienna', 'graz', // Austria
  'oslo', // Norway
  'helsinki', // Finland
  'copenhagen', // Denmark
  'tijuana', 'baja california', // Mexico (prevents 'california' usKeyword false match)
];

/**
 * Tag locations (multi-select)
 * Handles both legacy format (job.is_us_only, job.is_remote)
 * and ATS format (job.location as string, no job_country field)
 */
function tagLocations(job) {
  const tags = [];

  // ATS-provided workplace type (Lever: workplaceType, Ashby: is_remote).
  // More reliable than inferring from location string.
  const workplaceType = (job.workplace_type || '').toLowerCase();
  if (workplaceType === 'remote') tags.push('remote');
  else if (workplaceType === 'hybrid') tags.push('hybrid');

  // Combine all location fields for checking.
  // Normalize en-dash (–) and em-dash (—) to hyphen for consistent keyword matching.
  const locationStr = (
    job.location || job.job_city || job.job_location || job.job_country || ''
  ).toLowerCase().replace(/[\u2013\u2014]/g, '-');

  // OUT-FILTER-1: Detect Workday international format (COUNTRY-STATE-City) to prevent
  // false US tagging. WD locations like "IN-TN-CHENNAI" (India-TamilNadu-Chennai) get
  // stored as job_city with spaces: "IN TN CHENNAI". The "TN" state code matches
  // Tennessee in US_STATE_ABBR, and "IN" could match Indiana. This pattern catches
  // the format explicitly: 2-letter country (NOT "us") + space/hyphen + 2-letter state.
  // Pattern: starts with 2-letter country code (not "us" or "usa"), then delimiter,
  // then 2-letter state code. Examples: "IN TN CHENNAI", "CA-ON-Toronto", "GB-LON".
  const wdIntlPattern = /^([a-z]{2})[\s-]([a-z]{2})\b/;
  const wdIntlMatch = locationStr.match(wdIntlPattern);
  if (wdIntlMatch && wdIntlMatch[1] !== 'us' && wdIntlMatch[1] !== 'usa') {
    // Confirmed international WD format (non-US country + state code).
    // Skip US tagging entirely. The NON_US_LOCATIONS check below will still
    // catch countries like "india", "canada" etc., but this prevents false
    // matches on state codes like "TN" (Tamil Nadu != Tennessee).
    return tags; // Empty locations array = filtered out by consumers
  }

  // is_us_only takes priority over all location string analysis.
  // Must be checked FIRST — hospital campus names like "Indian River Hospital" contain
  // NON_US_LOCATIONS substrings ("india") that would otherwise falsely block the us tag.
  const hasNonUS = job.is_us_only !== true &&
    NON_US_LOCATIONS.some(place => locationStr.includes(place));

  if (job.is_us_only === true) {
    tags.push('us');
  } else if (locationStr) {
    // AGG-8: Check US indicators BEFORE applying non-US blocklist.
    // Multi-country listings ("Canada; United States", "Remote (Canada / USA)")
    // contain both non-US and US signals. Previous logic blocked US detection
    // if ANY non-US location was present. Now: US signal wins over non-US blocklist,
    // because the job IS available in the US regardless of other countries.
    // ATS jobs with a location that didn't match non-US list: check for US indicators
    const usKeywords = [
      // Full state names
      'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
      'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
      'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
      'minnesota','mississippi','missouri','montana','nebraska','nevada',
      'new hampshire','new jersey','new mexico','new york','north carolina',
      'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
      'south carolina','south dakota','tennessee','texas','utah','vermont',
      'virginia','washington','west virginia','wisconsin','wyoming','district of columbia',
      // Common US cities (synced with US_CITIES_SLUG in workday.js — WD-F7 fix)
      'san francisco', 'los angeles', 'chicago', 'seattle', 'austin',
      'boston', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'phoenix',
      'cleveland', 'kansas city', 'philadelphia', 'san diego', 'minneapolis',
      'detroit', 'portland', 'las vegas', 'baltimore', 'nashville', 'memphis',
      'louisville', 'milwaukee', 'albuquerque', 'tucson', 'sacramento',
      'salt lake city', 'raleigh', 'richmond', 'pittsburgh', 'cincinnati',
      'indianapolis', 'columbus', 'charlotte', 'jacksonville', 'san antonio',
      // Additional US cities from US_CITIES_SLUG (Workday slug parser) — WD-F7
      'san jose', 'fort worth', 'fresno', 'mesa', 'omaha', 'colorado springs',
      'long beach', 'virginia beach', 'tampa', 'new orleans', 'arlington',
      'wichita', 'bakersfield', 'aurora', 'anaheim', 'santa ana', 'corpus christi',
      'riverside', 'st. louis', 'st louis', 'saint louis', 'lexington', 'stockton',
      'st. paul', 'st paul', 'saint paul', 'greensboro', 'toledo', 'newark', 'plano',
      'henderson', 'lincoln', 'buffalo', 'fort wayne', 'jersey city', 'chula vista',
      'orlando', 'st. petersburg', 'st petersburg', 'norfolk', 'chandler', 'laredo',
      'madison', 'durham', 'lubbock', 'winston-salem', 'garland', 'glendale',
      'hialeah', 'reno', 'baton rouge', 'irvine', 'chesapeake', 'scottsdale',
      'fremont', 'gilbert', 'san bernardino', 'birmingham', 'rochester', 'spokane',
      'des moines', 'montgomery',
      // Tech hubs / defense corridors
      'mclean', 'tysons', 'bethesda', 'herndon', 'reston', 'redmond', 'bellevue',
      'mountain view', 'sunnyvale', 'santa clara', 'cupertino', 'menlo park',
      'palo alto', 'brooklyn', 'manhattan', 'cambridge', 'ann arbor', 'boulder',
      'san ramon', 'foster city', 'santa monica', 'el segundo', 'torrance',
      'thousand oaks', 'princeton', 'parsippany', 'hackensack', 'morristown',
      // Additional Workday tenant cities
      'lehi', 'waltham', 'irving',
      // Explicit US remote indicators — bare "Remote" alone is NOT sufficient
      'united states', '- usa', ', usa', '(usa)', 'u.s.a', '- us', ', us',
 // AGG-8: patterns missed by audit (Mozilla "Remote US", DataCamp multi-country, etc.)
      'remote us',       // "Remote US" — no prefix before "us"
      '/ usa',           // "Remote (Canada / USA)" — slash-separated
      '/ us',            // alternative slash format
      // AGG-LOC-2: Missing US location patterns
      'nyc',             // "NYC" — Suno, Replit, GPTZero
      'u.s.',            // "Remote U.S." — Vanta
      '(us)',            // "Remote(US)" — HighLevel
      'north america',   // "Remote (North America)" — Hightouch (implies US presence)
      'teleworker us',   // "6314 Remote/Teleworker US" — Leidos defense contractor
    ];
    // All 50 state abbreviations: match after comma only (comma-delimited, e.g. "Boise, ID").
    // Previous regex matched after space/pipe too — caused "Vaci ut 47" to match 'ut' as Utah.
    // Comma-only is stricter and matches the "City, ST" convention used by all major ATS systems.
    const US_STATE_ABBR = new Set([
      'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
      'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
      'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
      'va','wa','wv','wi','wy','dc'
    ]);
    const stateAbbrRe = /,\s*([a-z]{2})\b/g;
    let stateAbbrM;
    let hasStateAbbr = false;
    while ((stateAbbrM = stateAbbrRe.exec(locationStr)) !== null) {
      if (US_STATE_ABBR.has(stateAbbrM[1])) { hasStateAbbr = true; break; }
    }

    // that aren't caught by delimiter-prefixed patterns ('- usa', ', usa')
    const hasUsaWord = /\busa\b/i.test(locationStr);
    const hasUsKeyword = usKeywords.some(s => locationStr.includes(s)) || hasStateAbbr || hasUsaWord;

    if (hasUsKeyword) {
      // signal is a real country match or just a substring collision.
      // "Indianapolis, IN" contains "india" (substring). "Cambridge, United Kingdom"
      // contains "cambridge" (US city). The non-US signal is reliable only when
      // it's a full country/city name NOT embedded in a US place name.
      if (hasNonUS) {
        // Explicit non-US country that can't be a US substring
        // Mexico needs special handling: "New Mexico" is a US state, but bare "Mexico" is non-US
        const hasMexico = /\bmexico\b/i.test(locationStr) && !/\bnew mexico\b/i.test(locationStr);
        const hasRealNonUSCountry = hasMexico || /\bunited kingdom\b|\baustralia\b|\bgermany\b|\bfrance\b|\bjapan\b|\bswitzerland\b|\bsweden\b|\bnetherlands\b|\bireland\b|\bsingapore\b|\bbrazil\b|\bcanada\b|\bcolombia\b|\bspain\b|\bisrael\b|\bsouth korea\b|\bnew zealand\b|\bsouth africa\b|\bpoland\b|\bczech\b|\bdenmark\b|\bnorway\b|\bfinland\b|\bbelgium\b|\baustria\b|\bitaly\b|\bportugal\b|\bhungary\b|\bromania\b|\bturkey\b|\btaiwan\b/i.test(locationStr);
        // Non-US countries whose names collide with US places — only block if NOT in a US context
        // 'india' → "Indianapolis, IN" is US. "Bangalore, India" is not.
        // 'mexico' → "New Mexico" is US. "Mexico City" is not.
        // 'canada' → "Remote US & Canada" is multi-country.
        // 'georgia' → US state. "Georgia (country)" would need explicit signal.
        const hasCollisionNonUS = !hasRealNonUSCountry && hasNonUS;

        if (hasRealNonUSCountry) {
          // Real non-US country present. Only tag US if explicit US country signal too (multi-country).
          const hasExplicitUSCountry = /\bunited states\b|\busa\b|\bus\s*[&;\/]|\b(?:remote|hybrid)\s+us\b|,\s*us\b/i.test(locationStr);
          if (hasExplicitUSCountry) {
            tags.push('us'); // Multi-country
          }
          // else: non-US country wins over city/state match
        } else {
          // Non-US signal is a substring collision (india/mexico/canada/georgia) —
          // US keyword is more specific, tag US
          tags.push('us');
        }
      } else {
        tags.push('us');
      }
    } else if (hasNonUS) {
      // Non-US location detected and NO US signal found — skip US tag.
    }

    // Layer 2: company-slug fallback for ambiguous bare location strings.
    // Only fires when Layer 1 returned no 'us' signal. Applies to known US-HQ companies
    // that post with bare strings ('In-Office', 'Remote', 'N Locations') with no city/state.
    // Multinational companies are deliberately excluded — their bare-string posts could be anywhere.
    if (!tags.includes('us')) {
      const isAmbiguousBare = /^(in-office|remote|work from home|hybrid|\d+\s+locations?)$/i.test(locationStr.trim());
      if (isAmbiguousBare && US_HQ_SLUGS.has(job.company_slug)) {
        tags.push('us');
      }
    }

    // Layer 2b: US-only health systems — post with facility names as location strings.
    // No bare-string restriction. NON_US blocklist ran first (hasNonUS check above).
    // Only slugs with ZERO confirmed non-US offices — see US_HQ_ONLY_SLUGS definition.
    if (!tags.includes('us') && !hasNonUS && US_HQ_ONLY_SLUGS.has(job.company_slug)) {
      tags.push('us');
    }

    // Layer 3: explicit US pattern strings not caught by Layer 1 keywords.
    // 'USA - Remote', 'USA Remote' — reversed order vs '- usa' keyword.
    // 'US-XX-...' — Workday dash-separated site codes (US-CT-EAST HARTFORD-...).
    // 'US XX City' — Workday space-separated site codes (US VA Sterling, US NC Cary).
    // 'US - Remote', 'US - CO, Westminster' — Workday US-dash format (LOC-AUDIT-2).
    // 'XX - City' — Workday ST-City format (LOC-AUDIT-2): CT - Hartford, FL - Miami.
    if (!tags.includes('us')) {
      if (/^usa[\s\-:]/i.test(locationStr) ||
          /^us-[a-z]{2}-/i.test(locationStr) ||
          /^us [a-z]{2} /i.test(locationStr) ||
          /^us\s*-\s*/i.test(locationStr)) {
        tags.push('us');
      }
    }

    // ST-City format: 'XX - CityName' used by PNC, Travelers, SoFi, etc.
    // Only match codes that are unambiguously US state abbreviations.
    // Excluded: IN (India collision), CA (Canada collision), and all ISO country codes.
    // LOC-AUDIT-2 data (2026-03-15): 286 recoverable jobs across FL/PA/NJ/DE/OH/TX/IL/CT etc.
    if (!tags.includes('us')) {
      const ST_CITY_US_CODES = new Set([
        'al','ak','az','ar','co','ct','de','fl','ga','hi','id','il','ia',
        'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
        'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
        'va','wa','wv','wi','wy','dc'
        // 'in' excluded — collides with India (Stripe: 'IN - Bengaluru')
        // 'ca' excluded — collides with Canada (RTX: 'CA-QC-LONGUEUIL')
      ]);
      const stCityM = locationStr.match(/^([a-z]{2})\s*-\s*\S/i);
      if (stCityM && ST_CITY_US_CODES.has(stCityM[1].toLowerCase()) && !hasNonUS) {
        tags.push('us');
      }
    }

    // If location exists but doesn't match US or non-US list, don't assume US
  }

  // Check for remote (deduplicate — workplace_type may have already added it)
  if (!tags.includes('remote')) {
    if (job.is_remote === true) {
      tags.push('remote');
    } else if (locationStr.includes('remote') && !hasNonUS) {
      tags.push('remote');
    }
  }

  // Check for hybrid (deduplicate)
  if (!tags.includes('hybrid') && locationStr.includes('hybrid')) {
    tags.push('hybrid');
  }

  // Check for on-site (not remote, not hybrid)
  if (job.is_remote === false && !tags.includes('remote') && !tags.includes('hybrid')) {
    tags.push('on_site');
  }

  return tags;
}

/**
 * Tag experience level based on year requirements in the job description.
 * Values align with tags.employment vocabulary: entry_level / mid_level / senior_level / unknown.
 *
 * Classification thresholds (minimum years mentioned):
 *   0–1 years  → entry_level
 *   2–3 years  → mid_level
 *   4+ years   → senior_level
 *   no match   → unknown
 *
 * Note: ~8.8% of entry_level-tagged jobs state 4+ year requirements — this reflects
 * real tension in the data (companies posting "entry-level" but requiring experience).
 * This is exposed honestly here, not corrected. The scoring engine should weight accordingly.
 */
function tagExperience(job) {
  const raw = (job.description || '') + ' ' + (job.title || '');

  // Strip HTML tags and decode common entities before pattern matching
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .toLowerCase();

  // Match "X+ years", "X years of/experience", "X-Y years" — extract the minimum number
  // Covers dominant ATS patterns: "1+ years of experience", "3+ years", "2-4 years"
  const YEAR_RE = /(\d+)\s*\+?\s*(?:to|-|–)?\s*\d*\s*years?\s*(?:of\s+)?(?:professional\s+)?(?:relevant\s+)?(?:work\s+)?(?:exp(?:erience)?|professional)/gi;
  const YEAR_SIMPLE = /(\d+)\s*\+\s*years?|(\d+)\s+years?\s+of/gi;

  const years = [];
  let m;
  while ((m = YEAR_RE.exec(text)) !== null) {
    const y = parseInt(m[1], 10);
    if (y > 0 && y <= 20) years.push(y);
  }
  if (years.length === 0) {
    while ((m = YEAR_SIMPLE.exec(text)) !== null) {
      const y = parseInt(m[1] || m[2], 10);
      if (y > 0 && y <= 20) years.push(y);
    }
  }

  if (years.length === 0) return 'unknown';

  const minYears = Math.min(...years);
  if (minYears <= 1) return 'entry_level';
  if (minYears <= 3) return 'mid_level';
  return 'senior_level';
}

/**
 * Tag special companies (multi-select)
 * NOTE: No downstream consumer currently reads tags.special for routing or filtering.
 * These tags are informational only — used for potential future features (search filters, badges).
 * Lists are representative, not comprehensive.
 */
function tagSpecial(job) {
  const tags = [];
  const companyName = (job.company_name || '').toLowerCase();

  // FAANG+ (Big Tech companies with high applicant interest)
  const faangCompanies = [
    'meta', 'amazon', 'apple', 'netflix', 'google',
    'alphabet', 'microsoft', 'nvidia'
  ];
  if (faangCompanies.some(company => companyName.includes(company))) {
    tags.push('faang');
  }

  // Unicorn startups (private companies valued >$1B, high applicant interest)
  const unicornCompanies = [
    'stripe', 'plaid', 'databricks', 'snowflake', 'airbnb',
    'robinhood', 'doordash', 'instacart', 'coinbase',
    'chime', 'rippling', 'epic games',
  ];
  if (unicornCompanies.some(company => companyName.includes(company))) {
    tags.push('unicorn');
  }

  // Fortune 500 (representative subset — not comprehensive)
  const fortune500Companies = [
    'walmart', 'amazon', 'apple', 'cvs health', 'unitedhealth',
    'mckesson', 'cardinal health', 'exxon', 'at&t', 'costco'
  ];
  if (fortune500Companies.some(company => companyName.includes(company))) {
    tags.push('fortune500');
  }

  return tags;
}

/**
 * Generate tag statistics for a batch of jobs
 * @param {Array} jobs - Tagged jobs
 * @returns {Object} - Tag statistics
 */
function generateTagStats(jobs) {
  const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);
  const stats = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  // G1 metric counters: US non-senior general rate
  let usNonSeniorTotal = 0, usNonSeniorGeneral = 0, usNonSeniorTech = 0;

  jobs.forEach(job => {
    if (!job.tags) return;

    const isUS = job.tags.locations?.includes('us');
    const isSenior = job.tags.employment === 'senior';
    const domains = job.tags.domains || [];
    const isGeneral = domains.length === 1 && domains[0] === 'general';
    const hasTech = domains.some(d => TECH_DOMAINS.has(d));

    // G1: US non-senior only
    if (isUS && !isSenior) {
      usNonSeniorTotal++;
      if (isGeneral) usNonSeniorGeneral++;
      if (hasTech) usNonSeniorTech++;
    }

    // Count employment tags (mutually exclusive)
    if (job.tags.employment) {
      stats.employment[job.tags.employment] = (stats.employment[job.tags.employment] || 0) + 1;
    }

    // Count domain tags (multi-select)
    if (job.tags.domains && Array.isArray(job.tags.domains)) {
      job.tags.domains.forEach(domain => {
        stats.domains[domain] = (stats.domains[domain] || 0) + 1;
      });
    }

    // Count location tags (multi-select)
    if (job.tags.locations && Array.isArray(job.tags.locations)) {
      job.tags.locations.forEach(location => {
        stats.locations[location] = (stats.locations[location] || 0) + 1;
      });
    }

    // Count experience tags (mutually exclusive)
    if (job.tags.experience) {
      stats.experience[job.tags.experience] = (stats.experience[job.tags.experience] || 0) + 1;
    }

    // Count special tags (multi-select)
    if (job.tags.special && Array.isArray(job.tags.special)) {
      job.tags.special.forEach(special => {
        stats.special[special] = (stats.special[special] || 0) + 1;
      });
    }
  });

  // G1 metric: general rate among US non-senior jobs
  const techPool = usNonSeniorTech + usNonSeniorGeneral;
  stats.g1 = usNonSeniorTotal > 0 ? {
    us_total: usNonSeniorTotal,
    us_general: usNonSeniorGeneral,
    us_general_rate_pct: Math.round((usNonSeniorGeneral / usNonSeniorTotal) * 1000) / 10,
    tech_us_total: usNonSeniorTech,
    tech_us_general_rate_pct: techPool > 0 ? Math.round((usNonSeniorGeneral / techPool) * 1000) / 10 : null,
  } : null;

  return stats;
}

// TAG-SELF-3: Expose keyword arrays for per-keyword health monitoring.
// Initialized lazily on first call to tagDomains(), then cached.
let _keywordMap = null;
function getKeywordMap() {
  return _keywordMap || {};
}

module.exports = {
  tagJob,
  tagJobs,
  tagEmployment,
  tagDomains,
  tagLocations,
  tagExperience,
  tagSpecial,
  generateTagStats,
  setCompanyOverrideMap,
  TAG_ENGINE_VERSION,
  getKeywordMap,
};
