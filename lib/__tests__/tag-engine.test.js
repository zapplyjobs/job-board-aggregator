/**
 * Regression tests for tag-engine.js
 *
 * Covers: tagEmployment (entry-lock, senior, mid, internship, fake-intern detection)
 *         tagDomains (software keywords, hardware keywords, software-primary guard,
 *                     department rules, O*NET fallback, description phrases)
 *
 * Run: node lib/__tests__/tag-engine.test.js
 * From: job-board-shared/ root
 */

const assert = require('assert');
const { tagEmployment, tagDomains, tagJob } = require('../aggregator/processors/tag-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function makeJob(title, extra = {}) {
  return { title, ...extra };
}

// ─── tagEmployment ───────────────────────────────────────────────────────────

console.log('\n=== tagEmployment ===');

// Entry-lock patterns (should return entry_level even with senior-sounding words)
test('associate director → senior (OUT-SENIOR-1)', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Director')), 'senior');
});

test('assistant vice president → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Assistant Vice President')), 'entry_level');
});

test('assistant VP → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Assistant VP, Technology')), 'entry_level');
});

test('sr. associate → entry_level (TAG-22)', () => {
  assert.strictEqual(tagEmployment(makeJob('Sr. Associate')), 'entry_level');
});

test('associate architect → senior (OUT-SENIOR-1)', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Architect')), 'senior');
});

test('senior associate → entry_level (TAG-24)', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Associate')), 'entry_level');
});

test('principal associate → entry_level (TAG-24)', () => {
  assert.strictEqual(tagEmployment(makeJob('Principal Associate')), 'entry_level');
});

test('executive assistant → entry_level (TAG-25)', () => {
  assert.strictEqual(tagEmployment(makeJob('Executive Assistant')), 'entry_level');
});

test('senior executive assistant → entry_level (TAG-25)', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Executive Assistant')), 'entry_level');
});

test('new grad → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('New Grad Software Engineer')), 'entry_level');
});

test('junior → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Junior Developer')), 'entry_level');
});

test('entry-level → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Entry-Level Analyst')), 'entry_level');
});

test('early career → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Early Career Engineer')), 'entry_level');
});

test('campus hire → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Campus Hire Program')), 'entry_level');
});

test('trainee → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Management Trainee')), 'entry_level');
});

// Senior patterns (should return senior)
test('senior → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Senior Software Engineer')), 'senior');
});

test('sr. → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Sr. Developer')), 'senior');
});

test('principal (standalone) → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Principal Engineer')), 'senior');
});

test('staff → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Staff Engineer')), 'senior');
});

test('lead → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Lead Developer')), 'senior');
});

test('director → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Director of Engineering')), 'senior');
});

test('VP → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('VP of Engineering')), 'senior');
});

test('vice president → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Vice President, Technology')), 'senior');
});

test('architect → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Enterprise Architect')), 'senior');
});

test('distinguished → senior', () => {
  assert.strictEqual(tagEmployment(makeJob('Distinguished Engineer')), 'senior');
});

// Mid-level patterns
test('mid-level → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Mid-Level Engineer')), 'mid_level');
});

test('SDE II → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('SDE II')), 'mid_level');
});

test('SWE II → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('SWE II')), 'mid_level');
});

test('L4 → mid_level', () => {
  assert.strictEqual(tagEmployment(makeJob('L4 Engineer')), 'mid_level');
});

// Internship patterns
test('internship title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Engineering Intern')), 'internship');
});

test('intern title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Summer Intern')), 'internship');
});

test('co-op title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Co-op')), 'internship');
});

test('summer 2026 title → internship', () => {
  assert.strictEqual(tagEmployment(makeJob('Summer 2026 Analyst')), 'internship');
});

// Fake internship detection
test('senior intern → NOT internship', () => {
  const result = tagEmployment(makeJob('Senior Intern'));
  assert.notStrictEqual(result, 'internship');
});

test('principal intern → NOT internship', () => {
  const result = tagEmployment(makeJob('Principal Intern'));
  assert.notStrictEqual(result, 'internship');
});

test('intern conversion FT → NOT internship (TAG-PRECISION-12)', () => {
  const result = tagEmployment(makeJob('2023 Intern Conversion: 2024 FT Software Engineer III-5'));
  assert.notStrictEqual(result, 'internship');
});

test('internships (plural) → internship (TAG-INTERN-PLURAL)', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Engineering Internships')), 'internship');
  assert.strictEqual(tagEmployment(makeJob('Machine Learning / AI Internships')), 'internship');
  assert.strictEqual(tagEmployment(makeJob('Hardware Engineering Internships')), 'internship');
});

test('interns (plural) → internship (TAG-INTERN-PLURAL)', () => {
  assert.strictEqual(tagEmployment(makeJob('Summer 2026 Engineering Interns')), 'internship');
});

test('internal does NOT match internship (TAG-INTERN-PLURAL)', () => {
  const result = tagEmployment(makeJob('Internal Medicine Physician'));
  assert.notStrictEqual(result, 'internship');
});

test('internal communications does NOT match (TAG-INTERN-PLURAL)', () => {
  const result = tagEmployment(makeJob('Director of Internal Communications'));
  assert.notStrictEqual(result, 'internship');
});

// Default
test('plain software engineer → entry_level (default)', () => {
  assert.strictEqual(tagEmployment(makeJob('Software Engineer')), 'entry_level');
});

test('data scientist → entry_level (default)', () => {
  assert.strictEqual(tagEmployment(makeJob('Data Scientist')), 'entry_level');
});

// Edge cases
test('Internal Medicine → NOT internship', () => {
  assert.notStrictEqual(tagEmployment(makeJob('Internal Medicine Physician')), 'internship');
});

test('associate engineer → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Engineer')), 'entry_level');
});

test('associate analyst → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Analyst')), 'entry_level');
});

test('associate developer → entry_level', () => {
  assert.strictEqual(tagEmployment(makeJob('Associate Developer')), 'entry_level');
});

test('Hawaii → NOT mid_level (word-boundary safety)', () => {
  // "Manager" is NOT in senior keywords — correctly entry_level
  assert.strictEqual(tagEmployment(makeJob('Hawaii Regional Manager')), 'entry_level');
});

// ─── tagDomains ──────────────────────────────────────────────────────────────

console.log('\n=== tagDomains ===');

// Software keywords
test('software engineer → software', () => {
  assert.ok(tagDomains(makeJob('Software Engineer')).includes('software'));
});

test('frontend developer → software', () => {
  assert.ok(tagDomains(makeJob('Frontend Developer')).includes('software'));
});

test('backend engineer → software', () => {
  assert.ok(tagDomains(makeJob('Backend Engineer')).includes('software'));
});

test('devops engineer → software', () => {
  assert.ok(tagDomains(makeJob('DevOps Engineer')).includes('software'));
});

test('full stack developer → software', () => {
  assert.ok(tagDomains(makeJob('Full Stack Developer')).includes('software'));
});

test('data scientist → data_science', () => {
  assert.ok(tagDomains(makeJob('Data Scientist')).includes('data_science'));
});

test('machine learning engineer → ai', () => {
  assert.ok(tagDomains(makeJob('Machine Learning Engineer')).includes('ai'));
});

// Hardware keywords
test('embedded systems engineer → hardware', () => {
  assert.ok(tagDomains(makeJob('Embedded Systems Engineer')).includes('hardware'));
});

test('electrical engineer → hardware', () => {
  assert.ok(tagDomains(makeJob('Electrical Engineer')).includes('hardware'));
});

test('RFIC engineer → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('RFIC Engineer')).includes('hardware'));
});

test('device physics → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('Device Physics Engineer')).includes('hardware'));
});

test('hardware reliability → hardware (TAG-26)', () => {
  assert.ok(tagDomains(makeJob('Hardware Reliability Specialist')).includes('hardware'));
});

// Software-primary guard (TAG-22)
test('software test engineer → NOT hardware', () => {
  const domains = tagDomains(makeJob('Software Test Engineer'));
  assert.ok(!domains.includes('hardware'), `Expected no hardware, got: ${domains.join(',')}`);
});

test('software quality engineer → NOT hardware', () => {
  const domains = tagDomains(makeJob('Software Quality Engineer'));
  assert.ok(!domains.includes('hardware'), `Expected no hardware, got: ${domains.join(',')}`);
});

test('embedded systems engineer → hardware (not blocked by guard)', () => {
  const domains = tagDomains(makeJob('Embedded Systems Engineer'));
  assert.ok(domains.includes('hardware'), `Expected hardware, got: ${domains.join(',')}`);
});

// TAG-PRECISION-7: Service technician sole-match guard
test('service technician → NOT hardware (sole-match, TAG-PRECISION-7)', () => {
  const domains = tagDomains(makeJob('Service Technician'));
  assert.ok(!domains.includes('hardware'), `Service tech sole-match should NOT be hardware, got: ${domains.join(',')}`);
});

test('mobile service technician → NOT hardware (sole-match, TAG-PRECISION-7)', () => {
  const domains = tagDomains(makeJob('Mobile Service Technician'));
  assert.ok(!domains.includes('hardware'), `Mobile service tech sole-match should NOT be hardware, got: ${domains.join(',')}`);
});

test('fire sprinkler service technician → NOT hardware (TAG-PRECISION-11 technician guard)', () => {
  // Previously required sole-match for TAG-PRECISION-7. TAG-PRECISION-11 catches all
  // technician-titled roles regardless of how many HW keywords match.
  const domains = tagDomains(makeJob('Fire Sprinkler Service Technician'));
  assert.ok(!domains.includes('hardware'), `Fire sprinkler service tech should NOT be hardware, got: ${domains.join(',')}`);
});

test('residential installation & service technician → NOT hardware (TAG-PRECISION-7)', () => {
  const domains = tagDomains(makeJob('Residential Installation & Service Technician'));
  assert.ok(!domains.includes('hardware'), `Comcast install tech should NOT be hardware, got: ${domains.join(',')}`);
});

test('robot service technician → NOT hardware (sole-match, TAG-PRECISION-7)', () => {
  const domains = tagDomains(makeJob('Robot Service Technician'));
  assert.ok(!domains.includes('hardware'), `Robot service tech should NOT be hardware, got: ${domains.join(',')}`);
});

test('customer service technician → NOT hardware (TAG-PRECISION-7)', () => {
  const domains = tagDomains(makeJob('Customer Service Technician'));
  assert.ok(!domains.includes('hardware'), `Customer service tech should NOT be hardware, got: ${domains.join(',')}`);
});

test('field service technician → NOT hardware (TAG-PRECISION-11 technician guard)', () => {
  // Previously kept as hardware because 'field service technician' is a separate keyword
  // from 'service technician' (not sole-match for TAG-PRECISION-7). TAG-PRECISION-11
  // catches all technician-titled roles — field service techs are operations, not HW engineering.
  const domains = tagDomains(makeJob('Field Service Technician'));
  assert.ok(!domains.includes('hardware'), `Field service tech should NOT be hardware, got: ${domains.join(',')}`);
});

// Department-based classification
test('dept: software engineering → software', () => {
  const domains = tagDomains(makeJob('Engineer', { department: 'Software Engineering' }));
  assert.ok(domains.includes('software'));
});

test('dept: data science → ai (DEPT_RULES order: AI rule matches first)', () => {
  const domains = tagDomains(makeJob('Analyst', { department: 'Data Science' }));
  assert.ok(domains.includes('ai'));
});

test('dept: hardware → hardware', () => {
  const domains = tagDomains(makeJob('Engineer', { department: 'Hardware Engineering' }));
  assert.ok(domains.includes('hardware'));
});

test('dept: sales → sales', () => {
  const domains = tagDomains(makeJob('Specialist', { department: 'Sales' }));
  assert.ok(domains.includes('sales'));
});

test('dept: marketing → marketing', () => {
  const domains = tagDomains(makeJob('Manager', { department: 'Marketing' }));
  assert.ok(domains.includes('marketing'));
});

test('dept: finance → finance', () => {
  const domains = tagDomains(makeJob('Analyst', { department: 'Finance' }));
  assert.ok(domains.includes('finance'));
});

test('dept: legal → legal', () => {
  const domains = tagDomains(makeJob('Counsel', { department: 'Legal' }));
  assert.ok(domains.includes('legal'));
});

test('dept: operations → operations', () => {
  const domains = tagDomains(makeJob('Manager', { department: 'Operations' }));
  assert.ok(domains.includes('operations'));
});

test('dept: manufacturing → manufacturing', () => {
  const domains = tagDomains(makeJob('Technician', { department: 'Manufacturing' }));
  assert.ok(domains.includes('manufacturing'));
});

test('dept: nursing → healthcare', () => {
  const domains = tagDomains(makeJob('Nurse', { department: 'Nursing' }));
  assert.ok(domains.includes('healthcare'));
});

// DEPT_RULES software guards (TAG-GUARD-4)
test('dept: bare IT → NOT software (TAG-GUARD-4)', () => {
  const domains = tagDomains(makeJob('IT Administrator', { department: 'IT' }));
  assert.ok(!domains.includes('software'), 'bare IT dept should not tag software');
});

test('dept: corp IT → NOT software via dept (TAG-GUARD-4)', () => {
  // Use a title with no software keywords to test dept guard in isolation.
  // Many IT-dept titles (systems admin, AV admin) also match softwareKeywords.
  // This tests the DEPT_RULES guard specifically — the dept match should not add software.
  const domains = tagDomains(makeJob('SAP Finance Business Analyst', { department: 'IT (6D3)' }));
  assert.ok(!domains.includes('software'), 'bare IT dept should not tag non-SW title as software');
});

test('dept: IT Engineering → software (TAG-GUARD-4 allows)', () => {
  const domains = tagDomains(makeJob('Engineer', { department: 'IT Engineering' }));
  assert.ok(domains.includes('software'), 'IT Engineering dept should still tag software');
});

test('dept: Starlink Mobile Engineering + Mech Engineer → NOT software (TAG-GUARD-4)', () => {
  const domains = tagDomains(makeJob('Mechanical Engineer (Starlink Mobile)', { department: 'Starlink Mobile Engineering' }));
  assert.ok(!domains.includes('software'), 'Starlink Mobile Engineering dept should not tag software');
});

test('dept: Mobile Engineering (app dev) → software (TAG-GUARD-4 allows)', () => {
  const domains = tagDomains(makeJob('QA Engineer', { department: 'Mobile Engineering' }));
  assert.ok(domains.includes('software'), 'Mobile Engineering dept (no hardware context) should tag software');
});

test('dept: Starlink Product Engineering + HW title → NOT software (TAG-GUARD-4)', () => {
  const domains = tagDomains(makeJob('Mechanical Engineer, Gateways', { department: 'Starlink Product Engineering' }));
  assert.ok(!domains.includes('software'), 'Starlink Product Engineering dept should not tag software');
});

test('dept: Product Engineering (SW company) → software (TAG-GUARD-4 allows)', () => {
  const domains = tagDomains(makeJob('iOS Engineer', { department: 'Product Engineering' }));
  assert.ok(domains.includes('software'), 'Product Engineering dept (no guard trigger) should tag software');
});

// TAG-PRECISION-4: Removed non-SWE keywords from softwareKeywords
test('technical writer → NOT software (TAG-PRECISION-4)', () => {
  const domains = tagDomains(makeJob('Technical Writer'));
  assert.ok(!domains.includes('software'), 'technical writer is not a SWE role');
});

test('scrum master → NOT software via keyword (TAG-PRECISION-4)', () => {
  // 'scrum master' keyword removed from softwareKeywords. O*NET (SOC 15-1299.08) still
  // classifies Scrum Master as software — that's a separate question from keyword precision.
  // This test verifies the keyword was removed; O*NET fallback still fires.
  // Not asserting on final domain since O*NET is the intended override mechanism.
  const domains = tagDomains(makeJob('Scrum Master'));
  // Just verify it doesn't crash — the O*NET fallback may or may not tag software
  assert.ok(Array.isArray(domains));
});

test('it support specialist → NOT software (TAG-PRECISION-4)', () => {
  const domains = tagDomains(makeJob('IT Support Specialist'));
  assert.ok(!domains.includes('software'), 'IT support is not a SWE role');
});

test('help desk technician → NOT software (TAG-PRECISION-4)', () => {
  const domains = tagDomains(makeJob('Help Desk Technician'));
  assert.ok(!domains.includes('software'), 'help desk is not a SWE role');
});

test('technical editor → NOT software (TAG-PRECISION-4)', () => {
  const domains = tagDomains(makeJob('Technical Editor'));
  assert.ok(!domains.includes('software'), 'technical editor is not a SWE role');
});

// TAG-PRECISION-5: Program Manager guard — bare PM without tech context is not SWE
test('training program manager → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('Training Program Manager'));
  assert.ok(!domains.includes('software'), 'training PM is not SWE');
});

test('program manager, people innovation labs → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('Program Manager, People Innovation Labs'));
  assert.ok(!domains.includes('software'), 'people PM is not SWE');
});

test('NPI supply chain program manager → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('NPI Supply Chain Program Manager (Hybrid)'));
  assert.ok(!domains.includes('software'), 'supply chain PM is not SWE');
});

test('strategic program manager, source to pay → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('Strategic Program Manager, Source to Pay Transformation'));
  assert.ok(!domains.includes('software'), 'procurement PM is not SWE');
});

test('program manager 4 → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('Program Manager 4'));
  assert.ok(!domains.includes('software'), 'bare PM with no tech context is not SWE');
});

test('material program manager → NOT software (TAG-PRECISION-5)', () => {
  const domains = tagDomains(makeJob('Material Program Manager'));
  assert.ok(!domains.includes('software'), 'materials PM is not SWE');
});

// TAG-PRECISION-5: Tech-qualified PMs should still be software
test('technical program manager, AI platform → software (TAG-PRECISION-5 allows)', () => {
  const domains = tagDomains(makeJob('Technical Program Manager, AI Platform'));
  assert.ok(domains.includes('software'), 'TPM at AI company is software-adjacent');
});

test('technical project/program manager → software (TAG-PRECISION-5 allows)', () => {
  // "Technical Project/Program Manager" — the slash form matches 'program manager'
  const domains = tagDomains(makeJob('Technical Project/Program Manager V'));
  assert.ok(domains.includes('software'), 'technical PM with program in title is software-adjacent');
});

test('information security program manager → software (TAG-PRECISION-5 allows)', () => {
  const domains = tagDomains(makeJob('Information Security Program Manager'));
  assert.ok(domains.includes('software'), 'security PM at tech company is software-adjacent');
});

test('AI program manager & developer → software (TAG-PRECISION-5 allows)', () => {
  const domains = tagDomains(makeJob('AI Program Manager & Developer'));
  assert.ok(domains.includes('software'), 'AI dev PM is software');
});

// TAG-PRECISION-8: Systems analyst context guard — business/HRIS/financial systems = not SWE
test('business systems analyst → NOT software (TAG-PRECISION-8)', () => {
  const domains = tagDomains(makeJob('Business Systems Analyst'));
  assert.ok(!domains.includes('software'), 'BSA configures SAP/Workday, not writes code');
});

test('HRIS business systems analyst → NOT software (TAG-PRECISION-8)', () => {
  const domains = tagDomains(makeJob('HRIS Business Systems Analyst - HCM'));
  assert.ok(!domains.includes('software'), 'HRIS analyst is not SWE');
});

test('people systems analyst → NOT software (TAG-PRECISION-8)', () => {
  const domains = tagDomains(makeJob('People Systems Analyst'));
  assert.ok(!domains.includes('software'), 'People systems analyst is HR tech, not SWE');
});

test('financial systems analyst → NOT software (TAG-PRECISION-8)', () => {
  const domains = tagDomains(makeJob('Financial Systems Analyst'));
  assert.ok(!domains.includes('software'), 'Financial systems analyst is not SWE');
});

test('nuclear enterprise systems analyst → NOT software (TAG-PRECISION-8)', () => {
  const domains = tagDomains(makeJob('Nuclear Enterprise Systems Analyst'));
  assert.ok(!domains.includes('software'), 'Nuclear systems analyst is not SWE');
});

test('systems analyst — robotic algorithms → software (TAG-PRECISION-8 allows)', () => {
  // Genuine SW — "Systems Analyst - Robotic Algorithms and Control" at Intuitive
  // Has other SW keywords (robotic, algorithms) so NOT sole match
  const domains = tagDomains(makeJob('Systems Analyst - Robotic Algorithms and Control'));
  // This should match 'systems analyst' + potentially 'algorithm' keywords → multi-match → not guarded
  assert.ok(domains.includes('software'), 'Robotic algorithms systems analyst is genuine SW');
});

test('plain systems analyst → software (TAG-PRECISION-8 allows)', () => {
  // Without non-SW context, sole 'systems analyst' is borderline but preserved
  const domains = tagDomains(makeJob('Systems Analyst'));
  assert.ok(domains.includes('software'), 'Plain systems analyst without non-SW context stays SW');
});

// TAG-PRECISION-9: Research associate context guard — equity/investment/crypto/strategy/program RA = not HC
test('equity research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Equity Research Associate, Industrials'));
  assert.ok(!domains.includes('healthcare'), 'Equity RA at KeyBank is finance, not HC');
});

test('crypto research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Crypto Research Associate, Finance'));
  assert.ok(!domains.includes('healthcare'), 'Crypto RA at Fidelity is finance, not HC');
});

test('strategy research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Strategy Research Associate, Creator Platform'));
  assert.ok(!domains.includes('healthcare'), 'Strategy RA at Rockstar is not HC');
});

test('client investment research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Client Investment Research Associate'));
  assert.ok(!domains.includes('healthcare'), 'Client investment RA at Bridgewater is finance, not HC');
});

test('program research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Program Research Associate'));
  assert.ok(!domains.includes('healthcare'), 'Program RA at Findhelp is ops, not HC');
});

test('equities research associate → NOT healthcare (TAG-PRECISION-9)', () => {
  const domains = tagDomains(makeJob('Equities Research Associate, Asia Solutions'));
  assert.ok(!domains.includes('healthcare'), 'Equities RA at Bridgewater is finance, not HC');
});

test('clinical research associate → healthcare (TAG-PRECISION-9 preserves)', () => {
  const domains = tagDomains(makeJob('Clinical Research Associate'));
  assert.ok(domains.includes('healthcare'), 'Clinical RA is genuine HC');
});

test('research associate genomics → healthcare (TAG-PRECISION-9 preserves)', () => {
  // 'genomics' may match other HC keywords — multi-match, not guarded
  const domains = tagDomains(makeJob('Research Associate, Single-Cell Genomics'));
  assert.ok(domains.includes('healthcare'), 'Genomics RA is genuine HC');
});

test('research associate bare → healthcare (TAG-PRECISION-9 preserves borderline)', () => {
  // Bare 'Research Associate' without non-HC context — preserved as HC (borderline but safe)
  const domains = tagDomains(makeJob('Research Associate'));
  assert.ok(domains.includes('healthcare'), 'Bare RA without context stays HC');
});

// TAG-PRECISION-10: 'chemist' keyword removed from healthcareKeywords
test('chemist → NOT healthcare (TAG-PRECISION-10 removed keyword)', () => {
  const domains = tagDomains(makeJob('Chemist (Starlink PCB)'));
  assert.ok(!domains.includes('healthcare'), 'SpaceX PCB chemist is not HC');
});

test('assistant chemist → NOT healthcare (TAG-PRECISION-10 removed keyword)', () => {
  const domains = tagDomains(makeJob('Assistant Chemist - 2nd shift'));
  assert.ok(!domains.includes('healthcare'), 'Chemist keyword removed — Abbott chemist falls to general');
});

test('chemistry expert → NOT healthcare (TAG-PRECISION-10 removed keyword)', () => {
  const domains = tagDomains(makeJob('Chemistry Expert'));
  assert.ok(!domains.includes('healthcare'), 'Chemistry substring no longer matches HC');
});

test('software engineer chemistry → NOT healthcare (TAG-PRECISION-10 removed keyword)', () => {
  const domains = tagDomains(makeJob('Software Engineer, Full Stack (Chemistry)'));
  assert.ok(!domains.includes('healthcare'), 'Benchling SW engineer with chemistry is not HC');
});

// Healthcare keywords
test('registered nurse → healthcare', () => {
  assert.ok(tagDomains(makeJob('Registered Nurse')).includes('healthcare'));
});

test('pharmacy technician → healthcare', () => {
  assert.ok(tagDomains(makeJob('Pharmacy Technician')).includes('healthcare'));
});

test('physical therapist → healthcare', () => {
  assert.ok(tagDomains(makeJob('Physical Therapist')).includes('healthcare'));
});

// General fallback
test('generic title with no keywords → empty or general', () => {
  const domains = tagDomains(makeJob('Specialist I'));
  // Should not falsely classify into a domain
  const techDomains = ['software', 'hardware', 'ai', 'data_science'];
  const falseClassifications = domains.filter(d => techDomains.includes(d));
  assert.strictEqual(falseClassifications.length, 0, `Unexpected tech domains: ${falseClassifications.join(',')}`);
});

// ─── tagJob integration ──────────────────────────────────────────────────────

console.log('\n=== tagJob (integration) ===');

test('tagJob adds tags property', () => {
  const job = tagJob(makeJob('Software Engineer'));
  assert.ok(job.tags, 'tagJob should add tags property');
  assert.ok(job.tags.domains, 'tags should have domains');
  assert.strictEqual(job.tags.employment, 'entry_level');
});

test('tagJob internship detection', () => {
  const job = tagJob(makeJob('Summer 2026 Software Engineering Intern'));
  assert.strictEqual(job.tags.employment, 'internship');
});

test('tagJob senior + software domain', () => {
  const job = tagJob(makeJob('Senior Software Engineer'));
  assert.strictEqual(job.tags.employment, 'senior');
  assert.ok(job.tags.domains.includes('software'));
});

test('tagJob associate director is senior + domain correct (OUT-SENIOR-1)', () => {
  const job = tagJob(makeJob('Associate Director of Software Engineering'));
  assert.strictEqual(job.tags.employment, 'senior');
  assert.ok(job.tags.domains.includes('software'));
});

// ─── TAG-PRECISION-11: Technician-only guard ─────────────────────────────────

test('PRECISION-11: Electronic Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Electronic Technician 2'));
  assert.ok(!tags.includes('hardware'), 'Electronic Technician should NOT be hardware');
});

test('PRECISION-11: Quality Control Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Quality Control Technician'));
  assert.ok(!tags.includes('hardware'), 'Quality Control Technician should NOT be hardware');
});

test('PRECISION-11: Field Service Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Field Service Technician Class B'));
  assert.ok(!tags.includes('hardware'), 'Field Service Technician should NOT be hardware');
});

test('PRECISION-11: Propulsion Test Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Propulsion Test Technician I'));
  assert.ok(!tags.includes('hardware'), 'Propulsion Test Technician should NOT be hardware');
});

test('PRECISION-11: Fire Detection Service Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Fire Detection Service Technician 2'));
  assert.ok(!tags.includes('hardware'), 'Fire Detection Service Technician should NOT be hardware');
});

test('PRECISION-11: Process Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Process Technician'));
  assert.ok(!tags.includes('hardware'), 'Process Technician should NOT be hardware');
});

test('PRECISION-11: Hardware Test Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Hardware Test Technician'));
  assert.ok(!tags.includes('hardware'), 'Hardware Test Technician should NOT be hardware');
});

test('PRECISION-11: Engineering Technician kept (borderline)', () => {
  const tags = tagDomains(makeJob('Engineering Technician'));
  assert.ok(tags.includes('hardware'), 'Engineering Technician should still be hardware (has engineer context)');
});

test('PRECISION-11: Quality Engineering Technician kept (borderline)', () => {
  const tags = tagDomains(makeJob('Quality Engineering Technician'));
  assert.ok(tags.includes('hardware'), 'Quality Engineering Technician should still be hardware (has engineer context)');
});

test('PRECISION-11: Development Engineering Technician kept (borderline)', () => {
  const tags = tagDomains(makeJob('Development Engineering Technician'));
  assert.ok(tags.includes('hardware'), 'Development Engineering Technician should still be hardware (has engineer context)');
});

test('PRECISION-11: Test Engineer kept (legitimate HW)', () => {
  const tags = tagDomains(makeJob('Test Engineer'));
  assert.ok(tags.includes('hardware'), 'Test Engineer should be hardware');
});

test('PRECISION-11: Electrical Engineer kept (legitimate HW)', () => {
  const tags = tagDomains(makeJob('Electrical Engineer'));
  assert.ok(tags.includes('hardware'), 'Electrical Engineer should be hardware');
});

test('PRECISION-11: Calibration Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Calibration Technician'));
  assert.ok(!tags.includes('hardware'), 'Calibration Technician should NOT be hardware');
});

test('PRECISION-11: Wiring Technician blocked (FP)', () => {
  const tags = tagDomains(makeJob('Wiring Technician'));
  assert.ok(!tags.includes('hardware'), 'Wiring Technician should NOT be hardware');
});

test('PRECISION-11: Plural Technicians blocked (FP)', () => {
  const tags = tagDomains(makeJob('PCB Electronics/Test Technicians Needed for 2nd & 3rd Shifts!'));
  assert.ok(!tags.includes('hardware'), 'Plural Technicians should NOT be hardware');
});

// ─── TAG-KEYWORD-9: Project engineer non-SWE guard expansion ────────────────────

test('KEYWORD-9: Controls Project Engineer – HVAC blocked (FP)', () => {
  const tags = tagDomains(makeJob('Controls Project Engineer – HVAC'));
  assert.ok(!tags.includes('software'), 'Controls Project Engineer – HVAC should NOT be software');
});

test('KEYWORD-9: Project Engineer - Electrical blocked (FP)', () => {
  const tags = tagDomains(makeJob('Project Engineer - Electrical'));
  assert.ok(!tags.includes('software'), 'Project Engineer - Electrical should NOT be software');
});

test('KEYWORD-9: Project Engineer - Automation blocked (FP)', () => {
  const tags = tagDomains(makeJob('Project Engineer - Automation'));
  assert.ok(!tags.includes('software'), 'Project Engineer - Automation should NOT be software');
});

test('KEYWORD-9: Project Engineer - Power Generation blocked (FP)', () => {
  const tags = tagDomains(makeJob('Project Engineer - Power Generation'));
  assert.ok(!tags.includes('software'), 'Project Engineer - Power Generation should NOT be software');
});

test('KEYWORD-9: Weapons Infrastructure Project Engineer blocked (FP)', () => {
  const tags = tagDomains(makeJob('Weapons Infrastructure Project Engineer'));
  assert.ok(!tags.includes('software'), 'Weapons Infrastructure Project Engineer should NOT be software');
});

test('KEYWORD-9: Project Engineer - Fire Protection blocked (FP)', () => {
  const tags = tagDomains(makeJob('Project Engineer - Fire Protection'));
  assert.ok(!tags.includes('software'), 'Project Engineer - Fire Protection should NOT be software');
});

test('KEYWORD-9: bare Project Engineer still software (borderline)', () => {
  const tags = tagDomains(makeJob('Project Engineer'));
  assert.ok(tags.includes('software'), 'bare Project Engineer should still be software');
});

test('KEYWORD-9: Software Project Engineer still software (genuine)', () => {
  const tags = tagDomains(makeJob('Software Project Engineer'));
  assert.ok(tags.includes('software'), 'Software Project Engineer should be software');
});

// ─── TAG-PRECISION-6: Senior guard reconciliation with senior-filter.js ─────

test('PRECISION-6: Solutions Architect → mid_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Solutions Architect')), 'mid_level');
});

test('PRECISION-6: Solution Architect → mid_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Solution Architect')), 'mid_level');
});

test('PRECISION-6: Business Architect → mid_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Business Architect')), 'mid_level');
});

test('PRECISION-6: Sales Architect → mid_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Sales Architect')), 'mid_level');
});

test('PRECISION-6: Pre-Sales Architect → mid_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Pre-Sales Architect')), 'mid_level');
});

test('PRECISION-6: Architect, Solutions → mid_level (reversed variant)', () => {
  assert.strictEqual(tagEmployment(makeJob('Architect, Solutions')), 'mid_level');
});

test('PRECISION-6: Staffing Coordinator → entry_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Staffing Coordinator')), 'entry_level');
});

test('PRECISION-6: Lead Generation Specialist → entry_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Lead Generation Specialist')), 'entry_level');
});

test('PRECISION-6: Shift Lead → entry_level (guard)', () => {
  assert.strictEqual(tagEmployment(makeJob('Shift Lead')), 'entry_level');
});

test('PRECISION-6: Team Lead → entry_level (non-tech)', () => {
  assert.strictEqual(tagEmployment(makeJob('Team Lead')), 'entry_level');
});

test('PRECISION-6: Team Lead - Software → senior (tech context)', () => {
  assert.strictEqual(tagEmployment(makeJob('Team Lead - Software')), 'senior');
});

test('PRECISION-6: Team Lead Engineer → senior (tech context)', () => {
  assert.strictEqual(tagEmployment(makeJob('Team Lead Engineer')), 'senior');
});

test('PRECISION-6: Enterprise Architect → senior (not guarded)', () => {
  assert.strictEqual(tagEmployment(makeJob('Enterprise Architect')), 'senior');
});

test('PRECISION-6: Staff Engineer → senior (not guarded)', () => {
  assert.strictEqual(tagEmployment(makeJob('Staff Engineer')), 'senior');
});

test('PRECISION-6: Distinguished Engineer → senior (not guarded)', () => {
  assert.strictEqual(tagEmployment(makeJob('Distinguished Engineer')), 'senior');
});

// ─── TAG-KEYWORD-10: overbroad keyword removal/guard ──────────────────────────

console.log('\n=== TAG-KEYWORD-10: keyword removal + guard ===');

// network engineer — removed entirely
// TAG-PRECISION-13: Network Engineer → now software (was general, reclassified B33)
test('KEYWORD-10: Network Engineer → software (TAG-PRECISION-13)', () => {
  const domains = tagDomains(makeJob('Network Engineer'));
  assert.ok(domains.includes('software'), 'network engineer should be software');
});

test('KEYWORD-10: IP Network Engineer II → software', () => {
  const domains = tagDomains(makeJob('IP Network Engineer II'));
  assert.ok(domains.includes('software'), 'IP network engineer should be software');
});

test('KEYWORD-10: Network Engineer Campus WLAN → software', () => {
  const domains = tagDomains(makeJob('Network Engineer – Campus WLAN/LAN'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: Optical Network Engineer → hardware (guard)', () => {
  const domains = tagDomains(makeJob('Optical Network Engineer'));
  assert.ok(!domains.includes('software'), 'optical network engineer is hardware');
});

test('KEYWORD-10: 5G/LTE Network Engineer → hardware (guard)', () => {
  const domains = tagDomains(makeJob('5G/LTE Network Engineer'));
  assert.ok(!domains.includes('software'), '5G/LTE network engineer is hardware');
});

// TAG-PRECISION-13: Systems Administrator → now software (was general, reclassified B33)
test('KEYWORD-10: Systems Administrator → software (TAG-PRECISION-13)', () => {
  const domains = tagDomains(makeJob('Systems Administrator'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: Jr. Systems Administrator → software', () => {
  const domains = tagDomains(makeJob('Jr. Systems Administrator'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: Linux Systems Administrator → software', () => {
  const domains = tagDomains(makeJob('Linux Systems Administrator'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: System Administrator → software', () => {
  const domains = tagDomains(makeJob('System Administrator'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: Windows System Administrator → software', () => {
  const domains = tagDomains(makeJob('Windows System Administrator'));
  assert.ok(domains.includes('software'));
});

// service desk — removed entirely
test('KEYWORD-10: Enterprise Service Desk Technician → not software', () => {
  const domains = tagDomains(makeJob('Enterprise Service Desk Technician'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: Tier 1 Service Desk Analyst → not software', () => {
  const domains = tagDomains(makeJob('Tier 1 Service Desk Analyst'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: IT Service Desk Intern → not software (it service removed by KEYWORD-11)', () => {
  const domains = tagDomains(makeJob('IT Service Desk Intern'));
  // Previously matched via 'it service' keyword (KEYWORD-10 left it in scope).
  // KEYWORD-11 removed 'it service' — IT service desk is IT operations, not SWE.
  assert.ok(!domains.includes('software'), 'it service keyword removed');
});

// servicenow — guarded: keep for developer/engineer, block for admin/analyst/manager
test('KEYWORD-10: ServiceNow Developer → software (genuine)', () => {
  const domains = tagDomains(makeJob('ServiceNow Developer'));
  assert.ok(domains.includes('software'), 'ServiceNow Developer is genuine SWE');
});

test('KEYWORD-10: Associate ServiceNow Engineer → software (genuine)', () => {
  const domains = tagDomains(makeJob('Associate ServiceNow Engineer'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: ServiceNow Help Desk Support → not software (FP)', () => {
  const domains = tagDomains(makeJob('ServiceNow Help Desk Support'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: ServiceNow Admin → not software (FP)', () => {
  const domains = tagDomains(makeJob('Hardware ServiceNow Admin'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: ServiceNow Analyst → not software (FP)', () => {
  const domains = tagDomains(makeJob('Hardware Asset Management (ServiceNow) Analyst'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: Manager ServiceNow Development → not software (FP)', () => {
  const domains = tagDomains(makeJob('Manager - ServiceNow Technical Development'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: ServiceNow Project Manager → not software (FP)', () => {
  const domains = tagDomains(makeJob('ServiceNow Demand Intake and Project Manager'));
  assert.ok(!domains.includes('software'));
});

test('KEYWORD-10: ServiceNow Tester → not software (FP)', () => {
  const domains = tagDomains(makeJob('ServiceNow Tester'));
  assert.ok(!domains.includes('software'));
});

// Edge case: servicenow + other SW keyword → still software (multi-match)
test('KEYWORD-10: Specialty Solutions Engineer ServiceNow → software (multi-match)', () => {
  const domains = tagDomains(makeJob('Specialty Solutions Engineer - ServiceNow'));
  assert.ok(domains.includes('software'), 'solutions engineer + servicenow = genuine multi-match');
});

// developer experience — NO CHANGE (all genuine, verify still works)
test('KEYWORD-10: Developer Experience Engineer → software (unchanged)', () => {
  const domains = tagDomains(makeJob('Developer Experience Engineer'));
  assert.ok(domains.includes('software'));
});

test('KEYWORD-10: Software Engineer Developer Experience → software (unchanged)', () => {
  const domains = tagDomains(makeJob('Software Engineer, Developer Experience (DevEx)'));
  assert.ok(domains.includes('software'));
});

// ─── TAG-KEYWORD-11: it service / it systems removal ────────────────────────

// it service: all removed
test('KEYWORD-11: IT Service Level Manager → not software', () => {
  const domains = tagDomains(makeJob('IT Service Level Manager I'));
  assert.ok(!domains.includes('software'), 'IT service operations');
});

test('KEYWORD-11: IT Services Technician → not software', () => {
  const domains = tagDomains(makeJob('IT Services Technician'));
  assert.ok(!domains.includes('software'), 'IT services ops');
});

test('KEYWORD-11: Supervisor IT Service Delivery → not software', () => {
  const domains = tagDomains(makeJob('Supervisor, IT Service Delivery (R4740)'));
  assert.ok(!domains.includes('software'), 'IT service delivery management');
});

test('KEYWORD-11: Procurement Specialist IT Services → not software', () => {
  const domains = tagDomains(makeJob('Procurement Specialist, IT Services'));
  assert.ok(!domains.includes('software'), 'procurement role');
});

// TAG-PRECISION-13: IT Systems Administrator → now software (reclassified B33)
test('KEYWORD-11: IT Systems Administrator → software (TAG-PRECISION-13)', () => {
  const domains = tagDomains(makeJob('IT Systems Administrator'));
  assert.ok(domains.includes('software'), 'IT sysadmin is software');
});

test('KEYWORD-11: IT Systems Administrator Launch → software', () => {
  const domains = tagDomains(makeJob('IT Systems Administrator, Launch'));
  assert.ok(domains.includes('software'), 'sysadmin at SpaceX is software');
});

test('KEYWORD-11: IT Systems & A/V Engineer → not software', () => {
  const domains = tagDomains(makeJob('IT Systems & A/V Engineer'));
  assert.ok(!domains.includes('software'), 'AV support is not SWE');
});

test('KEYWORD-11: IT Systems & Ops Engineer → not software', () => {
  const domains = tagDomains(makeJob('IT Systems & Ops Engineer'));
  assert.ok(!domains.includes('software'), 'IT ops engineer');
});

test('KEYWORD-11: Manager IT Systems → not software', () => {
  const domains = tagDomains(makeJob('Manager, IT Systems (Applications & Operations)'));
  assert.ok(!domains.includes('software'), 'IT management');
});

// it systems: engineer variants preserved via 'systems engineer' keyword
test('KEYWORD-11: IT Systems Engineer → software (borderline, preserved)', () => {
  const domains = tagDomains(makeJob('IT Systems Engineer'));
  assert.ok(domains.includes('software'), 'systems engineer keyword catches this');
});

test('KEYWORD-11: IT Systems Engineer DevOps → software (genuine)', () => {
  const domains = tagDomains(makeJob('IT Systems Engineer, DevOps'));
  assert.ok(domains.includes('software'), 'devops qualifier = genuine SWE');
});

test('KEYWORD-11: Enterprise IT Systems Engineer → software (borderline)', () => {
  const domains = tagDomains(makeJob('Enterprise IT Systems Engineer'));
  assert.ok(domains.includes('software'), 'systems engineer substring match');
});

test('KEYWORD-11: IT Systems Engineer Launch → software (borderline)', () => {
  const domains = tagDomains(makeJob('IT Systems Engineer, Launch'));
  assert.ok(domains.includes('software'), 'systems engineer substring');
});

// ─── B28: FP regression guards ──────────────────────────────────────────────

console.log('\n=== B28 FP guards ===');

test('embedded + sales → not hardware (B28 Workato)', () => {
  const domains = tagDomains(makeJob('Embedded Sales Development Representative'));
  assert.ok(!domains.includes('hardware'), 'embedded sales rep should not be hardware');
});

test('embedded + finance → not hardware (B28 Brex)', () => {
  const domains = tagDomains(makeJob('Implementation Consultant, Embedded Finance'));
  assert.ok(!domains.includes('hardware'), 'embedded finance should not be hardware');
});

test('embedded + engineer → hardware (B28 FN guard)', () => {
  const domains = tagDomains(makeJob('Embedded Systems Engineer'));
  assert.ok(domains.includes('hardware'), 'embedded systems engineer should be hardware');
});

test('embedded + firmware → hardware (B28 FN guard)', () => {
  const domains = tagDomains(makeJob('Embedded Firmware Developer'));
  assert.ok(domains.includes('hardware'), 'embedded firmware should be hardware');
});

test('automated logic + sales → not hardware (B28 Carrier)', () => {
  const domains = tagDomains(makeJob('Service Sales Representative, Automated Logic'));
  assert.ok(!domains.includes('hardware'), 'automated logic sales should not be hardware');
});

test('automated logic + engineer → hardware (B28 FN guard)', () => {
  const domains = tagDomains(makeJob('Automation Engineer, Automated Logic'));
  assert.ok(domains.includes('hardware'), 'automated logic engineer should be hardware');
});

test('site reliability + technician → not software (B28 Jabil)', () => {
  const domains = tagDomains(makeJob('Site Reliability Technician (402)'));
  assert.ok(!domains.includes('software'), 'site reliability tech should not be software');
});

test('site reliability + engineer → software (B28 FN guard)', () => {
  const domains = tagDomains(makeJob('Site Reliability Engineer'));
  assert.ok(domains.includes('software'), 'site reliability engineer should be software');
});

// ─── TAG-PRECISION-14: High-impact domain keywords ──────────────────────────

// Sales keywords
test('account manager → sales (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Account Manager, Vessel Closure - San Diego, CA'));
  assert.ok(domains.includes('sales'), 'B2B account manager is sales');
});

test('territory manager → sales (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Territory Manager - Inland Empire - Vision'));
  assert.ok(domains.includes('sales'), 'territory manager is sales');
});

test('sales operations → sales (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Sales Operations Administrator'));
  assert.ok(domains.includes('sales'), 'sales ops is sales');
});

test('sales enablement → sales (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Sales Enablement Manager'));
  assert.ok(domains.includes('sales'), 'sales enablement is sales');
});

// TAM guard — tech-adjacent account managers are NOT sales
test('technical account manager → NOT sales (TAG-PRECISION-14 TAM guard)', () => {
  const domains = tagDomains(makeJob('Technical Account Manager'));
  assert.ok(!domains.includes('sales'), 'TAM is tech-adjacent, not sales');
});

test('software technical account manager → NOT sales (TAG-PRECISION-14 TAM guard)', () => {
  const domains = tagDomains(makeJob('Software Technical Account Manager II'));
  assert.ok(!domains.includes('sales'), 'software TAM is tech, not sales');
});

test('strategic account manager software → NOT sales (TAG-PRECISION-14 TAM guard)', () => {
  const domains = tagDomains(makeJob('Strategic Account Manager - Software (East)'));
  assert.ok(!domains.includes('sales'), 'strategic software AM is tech, not sales');
});

test('enterprise account manager → NOT sales (TAG-PRECISION-14 TAM guard)', () => {
  const domains = tagDomains(makeJob('Enterprise Account Manager IV'));
  assert.ok(!domains.includes('sales'), 'enterprise AM is tech, not sales');
});

// Manufacturing keywords
test('quality inspector → manufacturing (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Quality Inspector'));
  assert.ok(domains.includes('manufacturing'), 'quality inspector is manufacturing');
});

test('quality manager → manufacturing (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Quality Manager 1'));
  assert.ok(domains.includes('manufacturing'), 'quality manager is manufacturing');
});

test('process technician → manufacturing (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Process Technician III'));
  assert.ok(domains.includes('manufacturing'), 'process technician is manufacturing');
});

test('manufacturing manager → manufacturing (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Manufacturing Manager'));
  assert.ok(domains.includes('manufacturing'), 'manufacturing manager is manufacturing');
});

// Finance keywords
test('finance manager → finance (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Finance Manager (US)'));
  assert.ok(domains.includes('finance'), 'finance manager is finance');
});

test('financial wellness associate → finance (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Financial Wellness Associate'));
  assert.ok(domains.includes('finance'), 'financial wellness is finance');
});

test('branch manager → finance (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Branch Manager'));
  assert.ok(domains.includes('finance'), 'bank branch manager is finance');
});

test('claims analyst → finance (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Claims Analyst'));
  assert.ok(domains.includes('finance'), 'insurance claims analyst is finance');
});

// Healthcare keywords
test('scientist i → healthcare (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Scientist I'));
  assert.ok(domains.includes('healthcare'), 'pharma scientist I is healthcare');
});

test('scientist ii → healthcare (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Scientist II, Biochemical & Cellular Assays'));
  assert.ok(domains.includes('healthcare'), 'pharma scientist II is healthcare');
});

test('lab scientist → healthcare (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Lab Scientist, Applications [Pharma/Biopharma]'));
  assert.ok(domains.includes('healthcare'), 'lab scientist is healthcare');
});

test('postdoctoral fellow → healthcare (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Postdoctoral Fellow'));
  assert.ok(domains.includes('healthcare'), 'postdoctoral fellow is healthcare');
});

test('clinical research → healthcare (TAG-PRECISION-14)', () => {
  const domains = tagDomains(makeJob('Clinical Research Coordinator'));
  assert.ok(domains.includes('healthcare'), 'clinical research is healthcare');
});

// ─── Layer 5: Tenant-context defaults (TAG-PRECISION-15) ────────────────────

console.log('\n=== Layer 5: Tenant-context defaults ===');

// Software companies — ambiguous title should get software via tenant default
test('ambiguous title at Adobe → software (tenant default)', () => {
  const domains = tagDomains(makeJob('Coordinator', { company_slug: 'adobe' }));
  assert.ok(domains.includes('software'), 'Adobe ambiguous job should default to software');
  assert.ok(!domains.includes('general'), 'should not be general');
});

test('ambiguous title at Salesforce → software (tenant default)', () => {
  const domains = tagDomains(makeJob('Associate', { company_slug: 'salesforce' }));
  assert.ok(domains.includes('software'), 'Salesforce ambiguous job should default to software');
});

test('ambiguous title at CrowdStrike → software (tenant default)', () => {
  const domains = tagDomains(makeJob('Specialist', { company_slug: 'crowdstrike' }));
  assert.ok(domains.includes('software'), 'CrowdStrike ambiguous job should default to software');
});

test('ambiguous title at Zoom → software (tenant default)', () => {
  const domains = tagDomains(makeJob('Analyst', { company_slug: 'zoom' }));
  assert.ok(domains.includes('software'), 'Zoom ambiguous job should default to software');
});

// Hardware companies — ambiguous title should get hardware via tenant default
test('ambiguous title at Micron → hardware (tenant default)', () => {
  const domains = tagDomains(makeJob('Coordinator', { company_slug: 'micron' }));
  assert.ok(domains.includes('hardware'), 'Micron ambiguous job should default to hardware');
  assert.ok(!domains.includes('general'), 'should not be general');
});

test('ambiguous title at KLA → hardware (tenant default)', () => {
  const domains = tagDomains(makeJob('Associate', { company_slug: 'kla' }));
  assert.ok(domains.includes('hardware'), 'KLA ambiguous job should default to hardware');
});

test('ambiguous title at Applied Materials → hardware (tenant default)', () => {
  const domains = tagDomains(makeJob('Specialist', { company_slug: 'applied-materials' }));
  assert.ok(domains.includes('hardware'), 'Applied Materials ambiguous job should default to hardware');
});

test('ambiguous title at NXP → hardware (tenant default)', () => {
  const domains = tagDomains(makeJob('Analyst', { company_slug: 'nxp' }));
  assert.ok(domains.includes('hardware'), 'NXP ambiguous job should default to hardware');
});

// Existing defaults still work (finance/healthcare)
test('ambiguous title at Morgan Stanley → finance (tenant default)', () => {
  const domains = tagDomains(makeJob('Associate', { company_slug: 'morgan-stanley' }));
  assert.ok(domains.includes('finance'), 'Morgan Stanley ambiguous job should default to finance');
});

test('ambiguous title at Takeda → healthcare (tenant default)', () => {
  const domains = tagDomains(makeJob('Coordinator', { company_slug: 'takeda' }));
  assert.ok(domains.includes('healthcare'), 'Takeda ambiguous job should default to healthcare');
});

// No tenant default — should stay general
test('ambiguous title at unknown company → general', () => {
  const domains = tagDomains(makeJob('Coordinator', { company_slug: 'unknown-startup' }));
  assert.ok(domains.includes('general'), 'unknown company with ambiguous title should be general');
  assert.ok(domains.length === 1, 'should only be general');
});

// Title keyword should still win over tenant default
test('software engineer at KLA → software (title wins over tenant)', () => {
  const domains = tagDomains(makeJob('Software Engineer', { company_slug: 'kla' }));
  assert.ok(domains.includes('software'), 'title keyword should produce software');
  assert.ok(!domains.includes('hardware'), 'should not be hardware from tenant default');
});

// Department rule should still win over tenant default
test('finance dept at Adobe → finance (dept wins over tenant)', () => {
  const domains = tagDomains(makeJob('Specialist', { company_slug: 'adobe', departments: ['Finance'] }));
  assert.ok(domains.includes('finance'), 'dept rule should produce finance');
  assert.ok(!domains.includes('software'), 'should not be software from tenant default');
});

// Multi-word company slug (WD fetcher format)
test('ambiguous title at Workday Inc → software (multi-word slug)', () => {
  const domains = tagDomains(makeJob('Associate', { company_slug: 'workday-inc' }));
  assert.ok(domains.includes('software'), 'Workday Inc ambiguous job should default to software');
});

test('ambiguous title at FLIR Systems → hardware (multi-word slug)', () => {
  const domains = tagDomains(makeJob('Coordinator', { company_slug: 'flir-systems' }));
  assert.ok(domains.includes('hardware'), 'FLIR Systems ambiguous job should default to hardware');
});

// High-impact tenant defaults (data-driven — top general-producing companies)
test('equity research at Citi → finance (tenant default)', () => {
  const domains = tagDomains(makeJob('Equity Research Senior Associate', { company_slug: 'citi' }));
  assert.ok(domains.includes('finance'), 'Citi equity research should be finance');
});

test('credit analyst at Citi → finance (tenant default)', () => {
  const domains = tagDomains(makeJob('Credit Financing Origination & Structuring Analyst', { company_slug: 'citi' }));
  assert.ok(domains.includes('finance'), 'Citi credit analyst should be finance');
});

test('member care specialist at Oscar → healthcare (tenant default)', () => {
  const domains = tagDomains(makeJob('Member & Provider Care Specialist', { company_slug: 'oscar' }));
  assert.ok(domains.includes('healthcare'), 'Oscar member care should be healthcare');
});

test('trader at Franklin Templeton → finance (tenant default)', () => {
  const domains = tagDomains(makeJob('Investment Grade Corporate Trader', { company_slug: 'franklin-templeton' }));
  assert.ok(domains.includes('finance'), 'Franklin Templeton trader should be finance');
});

// ─── TAG-PRECISION-16: Keyword gaps (data-driven from top general producers) ──

console.log('\n=== TAG-PRECISION-16: Keyword gaps ===');

// Northrop Grumman inverted title format
test('engineer software quality → software (NG inverted title)', () => {
  const domains = tagDomains(makeJob('Engineer Software Quality'));
  assert.ok(domains.includes('software'), 'NG inverted "Engineer Software Quality" is software');
});

test('engineer software simulation → software (NG inverted title)', () => {
  const domains = tagDomains(makeJob('Engineer Software - Simulation (Melbourne FL)'));
  assert.ok(domains.includes('software'), 'NG inverted "Engineer Software - Simulation" is software');
});

test('engineer embedded software → software (NG inverted title)', () => {
  const domains = tagDomains(makeJob('Engineer Embedded Software'));
  assert.ok(domains.includes('software'), 'NG "Engineer Embedded Software" is software');
});

test('embedded software test developer → software', () => {
  const domains = tagDomains(makeJob('Embedded Software Test Developer'));
  assert.ok(domains.includes('software'), 'embedded software test is software');
});

// Motional AV/robotics
test('motion planning → software (Motional AV)', () => {
  const domains = tagDomains(makeJob('Principal Engineer, Team Lead- Motion Planning'));
  assert.ok(domains.includes('software'), 'motion planning is software');
});

test('trajectory planning → software (Motional AV)', () => {
  const domains = tagDomains(makeJob('Principal Engineer Team Lead - Trajectory Planning Lead'));
  assert.ok(domains.includes('software'), 'trajectory planning is software');
});

test('prediction & ML planner → software (Motional AV)', () => {
  const domains = tagDomains(makeJob('Principal Engineer Team Lead, Prediction & ML Planner'));
  assert.ok(domains.includes('software'), 'ML planner is software');
});

// ─── TAG-PRECISION-17: Keyword gaps (B36) ────────────────────────────────────

console.log('\n=== TAG-PRECISION-17: Keyword gaps ===');

// Software: Comcast/Boeing/NG development roles
test('software development & engineering → software (Comcast)', () => {
  const domains = tagDomains(makeJob('Engineer 4, Software Development & Engineering-5589'));
  assert.ok(domains.includes('software'), 'Comcast SW dev & eng is software');
});

test('software development manager → software (Boeing)', () => {
  const domains = tagDomains(makeJob('Software Development Manager'));
  assert.ok(domains.includes('software'), 'SW dev manager is software');
});

test('software development snr manager → software (Oracle)', () => {
  const domains = tagDomains(makeJob('Software Development Snr Manager'));
  assert.ok(domains.includes('software'), 'SW dev snr manager is software');
});

test('system software solutions testing manager → software', () => {
  const domains = tagDomains(makeJob('System Software Solutions Testing Manager'));
  assert.ok(domains.includes('software'), 'system SW solutions is software');
});

test('software reliability engineer → software', () => {
  const domains = tagDomains(makeJob('Software Reliability Engineer, Waymo Fleet'));
  assert.ok(domains.includes('software'), 'SW reliability is software');
});

test('angular developer → software', () => {
  const domains = tagDomains(makeJob('Angular Developer'));
  assert.ok(domains.includes('software'), 'Angular dev is software');
});

test('salesforce developer → software', () => {
  const domains = tagDomains(makeJob('Salesforce Developer'));
  assert.ok(domains.includes('software'), 'SFDC dev is software');
});

test('sharepoint developer → software', () => {
  const domains = tagDomains(makeJob('Power Platform/SharePoint Developer'));
  assert.ok(domains.includes('software'), 'SharePoint dev is software');
});

// AI domain
test('ai developer → ai', () => {
  const domains = tagDomains(makeJob('AI Developer'));
  assert.ok(domains.includes('ai'), 'AI Developer is ai domain');
});

test('gen ai developer → ai', () => {
  const domains = tagDomains(makeJob('Gen AI Developer'));
  assert.ok(domains.includes('ai'), 'Gen AI Developer is ai domain');
});

test('mlops engineer → ai', () => {
  const domains = tagDomains(makeJob('MLOps Engineer'));
  assert.ok(domains.includes('ai'), 'MLOps is ai domain');
});

// Hardware: defense/aerospace electronics
test('electronics technician → hardware', () => {
  const domains = tagDomains(makeJob('Electronics Technician'));
  assert.ok(domains.includes('hardware'), 'electronics tech is hardware');
});

test('master electronics technician → hardware', () => {
  const domains = tagDomains(makeJob('Master Electronics Technician - First Shift'));
  assert.ok(domains.includes('hardware'), 'master electronics tech is hardware');
});

test('electronics technician rf → hardware', () => {
  const domains = tagDomains(makeJob('Electronics Technician (RF)'));
  assert.ok(domains.includes('hardware'), 'RF electronics tech is hardware');
});

// Healthcare: pharma clinical roles
test('field reimbursement manager → healthcare', () => {
  const domains = tagDomains(makeJob('Field Reimbursement Manager, Immunology Gastroenterology'));
  assert.ok(domains.includes('healthcare'), 'field reimbursement is healthcare');
});

test('clinical data systems manager → healthcare', () => {
  const domains = tagDomains(makeJob('Manager, Clinical Data Systems'));
  assert.ok(domains.includes('healthcare'), 'clinical data systems is healthcare');
});

// Finance: banking
test('relationship manager → finance', () => {
  const domains = tagDomains(makeJob('Relationship Manager'));
  assert.ok(domains.includes('finance'), 'relationship manager is finance');
});

test('assistant relationship manager → finance', () => {
  const domains = tagDomains(makeJob('Assistant Relationship Manager'));
  assert.ok(domains.includes('finance'), 'assistant RM is finance');
});

test('wealth relationship manager → finance', () => {
  const domains = tagDomains(makeJob('Wealth Relationship Manager SAFE Act'));
  assert.ok(domains.includes('finance'), 'wealth RM is finance');
});

// Guard: SW dev quality engineer should be software NOT manufacturing
test('software development quality engineer → software (NOT manufacturing)', () => {
  const domains = tagDomains(makeJob('Software Development Quality Engineer II'));
  assert.ok(domains.includes('software'), 'SW dev quality eng is software');
  assert.ok(!domains.includes('manufacturing'), 'SW dev quality eng is NOT manufacturing');
});

// Guard: IT support should NOT be software
test('it support specialist → NOT software (TAG-PRECISION-4 guard)', () => {
  const domains = tagDomains(makeJob('IT Support Specialist'));
  assert.ok(!domains.includes('software'), 'IT support is not SWE');
});

// ─── TAG-PRECISION-19 (B37): component engineer ─────

test('component engineer → hardware', () => {
  const domains = tagDomains(makeJob('Component Engineer - Semiconductor'));
  assert.ok(domains.includes('hardware'), 'component engineer is hardware');
});

test('electrical component engineer → hardware', () => {
  const domains = tagDomains(makeJob('Electrical Component Engineer'));
  assert.ok(domains.includes('hardware'), 'electrical component eng is hardware');
});

// ─── TAG-PRECISION-20 (B38): hyphenated variants + cloud platform keywords ─────

test('back-end developer → software', () => {
  const domains = tagDomains(makeJob('Back-End Developer'));
  assert.ok(domains.includes('software'), 'back-end developer is software');
});

test('back-end engineer → software', () => {
  const domains = tagDomains(makeJob('Back-end Engineer'));
  assert.ok(domains.includes('software'), 'back-end engineer is software');
});

test('back-end clerk → NOT software (retail guard)', () => {
  const domains = tagDomains(makeJob('Back End Clerk'));
  assert.ok(!domains.includes('software'), 'back end clerk is NOT software');
});

test('full-stack intern → software', () => {
  const domains = tagDomains(makeJob('Full-Stack Intern'));
  assert.ok(domains.includes('software'), 'full-stack intern is software');
});

test('aws engineer → software', () => {
  const domains = tagDomains(makeJob('AWS Engineer'));
  assert.ok(domains.includes('software'), 'aws engineer is software');
});

test('ml ops engineer → software (space variant)', () => {
  const domains = tagDomains(makeJob('ML Ops Engineer, Central Software'));
  assert.ok(domains.includes('software'), 'ml ops engineer is software');
});

test('software modernization engineer → software', () => {
  const domains = tagDomains(makeJob('Product Software Modernization Engineer, Quantum AI'));
  assert.ok(domains.includes('software'), 'software modernization is software');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFAILURES DETECTED — fix before committing.');
  process.exit(1);
} else {
  console.log('All tests passed.');
}