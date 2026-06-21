const assert = require('assert');
const { requiresSeniorExperience, hasSeniorTitle } = require('../processors/senior-filter');

(function main() {
  assert.strictEqual(
    requiresSeniorExperience({
      title: 'Junior Strategy and Operations Analyst, Flow Macro (European Market Hours)',
      description: 'Recognized as one of Canada’s Best Employers for the past 8 years and committed to continuous learning.'
    }),
    false,
    'company-age blurbs must not trip senior experience filtering'
  );

  assert.strictEqual(
    requiresSeniorExperience({
      title: 'Software Engineer, Trust',
      description: 'You have 5–8 years of experience building or securing products.'
    }),
    false,
    'description ranges should use the minimum years value'
  );

  assert.strictEqual(
    requiresSeniorExperience({
      title: 'China Business Development',
      description: 'Have 10+ years of experience with a broker or local securities firm.'
    }),
    true,
    'genuinely senior experience requirements must still filter'
  );

  assert.strictEqual(
    requiresSeniorExperience({
      title: 'Platform Engineer',
      description: 'Minimum 7 years software engineering experience required.'
    }),
    true,
    'explicit senior description requirements must still filter'
  );

  assert.strictEqual(
    requiresSeniorExperience({
      title: 'Backend Engineer, 5-7 years',
      description: ''
    }),
    true,
    'title experience thresholds still use the title-specific matcher'
  );

  console.log('PASS: senior filter experience detection');
})();

// AGG-NEWGRAD-SUPFILTER-1: new industry-manager + industrial-supervisor patterns.
(function newGradSupFilter() {
  // New catches — clearly-not-new-grad line supervisors / branch / site leads.
  const shouldFilter = [
    'Branch Manager',
    'Citizens Branch Manager - Scottsdale Market',
    'Site Manager',
    'Data Center CoE Service Site Manager',
    'Shift Supervisor',
    'Field Service Supervisor',
    'Retail Supervisor',
    'Store Supervisor',
    'Floor Supervisor',
    'Center Supervisor',
    'Sales Floor Dept Supervisor - Building Materials',
    'Receiving Supervisor - Night Shift', // "shift" catches shift-schedule supervisors
  ];
  for (const title of shouldFilter) {
    assert.ok(hasSeniorTitle(title), `expected to filter: "${title}"`);
  }

  // Guards preserve ambiguous / entry-track variants.
  const shouldKeep = [
    'Assistant Branch Manager',          // assistant guard
    'Branch Manager Trainee',            // trainee guard
    'Branch Manager, Rotational Program',// rotational guard
    'Assistant Site Manager',            // assistant guard
    'Shift Lead',                        // shift-lead guard (hourly, entry-level)
    // Legit new-grad / IC manager titles — must NOT be filtered.
    'Product Manager',
    'Account Manager',
    'Program Manager',
    'Associate Manager',                 // associate guard
    'Product Manager Intern',            // (internship handled in filterSeniorJobs, but title has no senior signal)
    // No-FP: compound "site" must not match \\bsite\\b.
    'Website Manager',
    'Onsite Manager',
    'Software Engineer',
    'Data Analyst',
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }

  console.log('PASS: AGG-NEWGRAD-SUPFILTER-1 senior-title catches + guards');
})();

// AGG-NEWGRAD-SUPFILTER-2: industrial/supply-chain/technical line-supervisor niches.
(function newGradSupFilter2() {
  const shouldFilter = [
    'Logistics Supervisor',
    'Supervisor, Materials Management (Starship) - Night Shift',
    'Shipping Supervisor',
    'Assembly Supervisor',
    'Blood Bank Lab Supervisor',
    'Supervisor Sleep Lab - Neurology',
    'Supervisor Ramp - LAS',
    'Supervisor Cargo Customer Service - BWI',
    'Supervisor, Metrology',
    'Radiological Control Supervisor',
    'Aircraft Mechanic Supervisor',
    'Supervisor, Injection Molding',
    'Field Supervisor, Switchgear and Busbar',
    'ERS- NETA Testing Supervisor - Reno',
    'Flow Iron Supervisor',
    'Supervisor, Meter Services, Gas',
    'EHS Supervisor',
  ];
  for (const title of shouldFilter) {
    assert.ok(hasSeniorTitle(title), `expected to filter: "${title}"`);
  }

  // Guards still preserve ambiguous / entry-track variants of these niches.
  const shouldKeep = [
    'Associate Manufacturing Supervisor',     // associate guard
    'Assistant Lab Supervisor',               // assistant guard
    'Logistics Supervisor, Rotational Program',// rotational guard
    'Assembly Supervisor Trainee',            // trainee guard
    // Legit new-grad / IC titles with overlap-risk tokens must survive.
    'Materials Engineer',                     // IC engineer, no "supervisor"
    'Lab Scientist',                          // IC, no "supervisor"
    'Logistics Analyst',                      // IC analyst
    'Software Engineer',
    // DEFERRED-domain supervisor at SUPFILTER-2 time; `training` moved to FILTERED in SUPFILTER-4.
    // (security/culinary/nurse-clinical moved to FILTERED in SUPFILTER-3)
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }

  console.log('PASS: AGG-NEWGRAD-SUPFILTER-2 industrial line-supervisor niches + guards');
})();

// AGG-NEWGRAD-SUPFILTER-3: final consolidation — healthcare/hospitality/security line supervisors.
(function newGradSupFilter3() {
  const shouldFilter = [
    'Phlebotomy Supervisor',
    'RN Clinical Supervisor MICU (Nights)',
    'Supervisor, Nurse Administrator',
    'Supervisor Clinical Office - Obstetrics and Gynecology',
    'Culinary Supervisor - Darien Lake Amphitheater',
    'Food & Beverage Supervisor',
    'Restaurant Supervisor - House of Blues Myrtle Beach',
    'Beverage Supervisor - FirstBank Amphitheater',
    'LACC Security Supervisor (FT)',
    'Security Supervisor - Citizens Live at the Wylie',
  ];
  for (const title of shouldFilter) {
    assert.ok(hasSeniorTitle(title), `expected to filter: "${title}"`);
  }

  // Guards still preserve entry-track variants; legit ICs survive; deferred categories not caught.
  const shouldKeep = [
    'Assistant Culinary Supervisor',            // assistant guard
    'Phlebotomy Supervisor Trainee',            // trainee guard
    'Clinical Supervisor, Rotational Program',  // rotational guard
    'Food Scientist',                           // IC, no "supervisor"
    'Security Engineer',                        // IC, no "supervisor"
    'Clinical Data Analyst',                    // IC analyst
    // DEFERRED categories (broad/office-bordeline) must NOT be caught yet.
    'Finance Supervisor',                       // deferred (office/corporate)
    'Compliance Supervisor',                    // deferred (office/corporate)
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }

  console.log('PASS: AGG-NEWGRAD-SUPFILTER-3 healthcare/hospitality/security niches + guards');
})();

// AGG-NEWGRAD-SUPFILTER-4: technical/industrial training supervisors.
(function newGradSupFilter4() {
  const shouldFilter = [
    'Training Supervisor',
    'Weld Training Supervisor',
    'New Equipment Fielding/Training Supervisor',
  ];
  for (const title of shouldFilter) {
    assert.ok(hasSeniorTitle(title), `expected to filter: "${title}"`);
  }
  const shouldKeep = [
    'Training Supervisor, Rotational Program', // rotational guard (future-FP safety)
    'Training Supervisor Trainee',             // trainee guard
    'Assistant Training Supervisor',           // assistant guard
    // office/corporate borderline — still deferred (need operator judgment).
    'Finance Supervisor',
    'Compliance Supervisor',
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }
  console.log('PASS: AGG-NEWGRAD-SUPFILTER-4 training supervisor + rotational/trainee guards');
})();
