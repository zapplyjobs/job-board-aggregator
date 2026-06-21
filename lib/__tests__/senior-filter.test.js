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
