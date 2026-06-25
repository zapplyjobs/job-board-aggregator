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
    // Finance/Compliance Supervisor now FILTERED by SUPFILTER-5 (office/corporate resolved).
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
    // Finance/Compliance Supervisor now FILTERED by SUPFILTER-5 (office/corporate resolved).
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }
  console.log('PASS: AGG-NEWGRAD-SUPFILTER-4 training supervisor + rotational/trainee guards');
})();

// AGG-NEWGRAD-SUPFILTER-5: office/corporate supervisors (previously DEFERRED) — finance/accounting/
// revenue-cycle, customer-service/client-services, IT-service/dispatch, risk/AML/compliance,
// HR/admin/benefits, audit, corporate project/e-discovery; + adjective "Supervisory X" form.
(function newGradSupFilter5() {
  const shouldFilter = [
    // Finance / accounting / revenue-cycle / AR / billing / cost.
    'Supervisor, Cost Accounting',
    'Supervisor, Revenue Cycle Management',
    'Project Supervisor - Hospital A/R - PFS - Revenue Cycle',
    'Cash Posting & Credit Balance Supervisor - Hospital PFS',
    'Accounts Receivable Supervisor',
    'Finance Supervisor',
    // Customer-service / success / client-services / community / complaint.
    'Supervisor, Starlink Customer Support',
    'Supervisor, Customer Success Team',
    'Customer Service Supervisor',
    'Supervisor of Customer Service',
    'Supervisor, Community Response',
    'Supervisor Complaint Handling',
    // IT-service / service-delivery / application-support / dispatch / technical-service.
    'Supervisor, IT Service Delivery',
    'Application Support Supervisor',
    'Service Dispatch Supervisor',
    'Supervisor Technical Service',
    // Risk / AML / compliance / tariff.
    'AML Special Investigations Unit Supervisor',
    'Account Risk Engineering Supervisor',
    'Supervisor, GTC - Tariff Classification',
    'Compliance Supervisor',
    // HR / benefits / administrative / payroll / office.
    'HR Ops Supervisor',
    'Supervisor- Employee Benefits',
    'Supervisor, Administrative Services',
    // Audit (word-boundary guards never exempt "Internal Audit").
    'Supervisor, Internal Audit',
    // Project (corporate e-discovery).
    'E-Discovery Project Supervisor',
    // Adjective form "Supervisory X" (separate clause; the noun-form regex can't see it).
    'Supervisory Clerical',
    'Supervisory Accountant, Controllership',
  ];
  for (const title of shouldFilter) {
    assert.ok(hasSeniorTitle(title), `expected to filter: "${title}"`);
  }

  // Guards still preserve entry-track variants; legit new-grad / IC titles survive (no-FP).
  const shouldKeep = [
    'Associate Customer Service Supervisor',   // associate guard
    'Assistant Accounts Receivable Supervisor',// assistant guard
    'Audit Supervisor Trainee',                // trainee guard
    'Risk Supervisor, Rotational Program',     // rotational guard
    'Customer Success Associate',              // IC associate, no "supervisor"
    'IT Support Specialist',                   // IC, "support" not adjacent to "supervisor"
    'Project Manager',                         // legit new-grad-adjacent manager (not "supervisor")
    'Software Engineer',
    'Data Analyst',
    // KNOWN RESIDUAL (guard-bound, NOT a regex gap): the adjective clause WOULD catch this, but the
    // literal "Assistant" in the parenthetical fires ENTRY_LEVEL_GUARDS, which the spec preserves.
    'Supervisory Clerical (Executive Assistant)',
  ];
  for (const title of shouldKeep) {
    assert.ok(!hasSeniorTitle(title), `expected to KEEP (not filter): "${title}"`);
  }

  console.log('PASS: AGG-NEWGRAD-SUPFILTER-5 office/corporate supervisors + adjective form + guards');
})();
