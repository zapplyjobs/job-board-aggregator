const assert = require('assert');
const { requiresSeniorExperience } = require('../processors/senior-filter');

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
