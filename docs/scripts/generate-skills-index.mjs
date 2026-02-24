import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsJsonPath = join(__dirname, '../public/skills/skills.json');
const outputDir = join(__dirname, '../public/skills');
const pagesDir = join(outputDir, 'pages');

// Read skills data
const skillsData = JSON.parse(readFileSync(skillsJsonPath, 'utf-8'));
const skills = skillsData.skills;

// Create pages directory
mkdirSync(pagesDir, { recursive: true });

// Generate index.json
const owners = {};
skills.forEach((skill) => {
  if (!owners[skill.owner]) {
    owners[skill.owner] = 0;
  }
  owners[skill.owner]++;
});

const ownersList = Object.entries(owners)
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count);

const pageSize = 100;
const totalPages = Math.ceil(skills.length / pageSize);

const indexData = {
  total: skills.length,
  totalPages,
  pageSize,
  owners: ownersList,
};

writeFileSync(
  join(outputDir, 'index.json'),
  JSON.stringify(indexData, null, 2)
);

console.log(`Generated index.json with ${skills.length} skills and ${ownersList.length} owners`);

// Generate paginated files
for (let page = 1; page <= totalPages; page++) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageSkills = skills.slice(start, end);

  const pageData = {
    page,
    pageSize,
    totalPages,
    total: skills.length,
    skills: pageSkills,
  };

  writeFileSync(
    join(pagesDir, `page-${page}.json`),
    JSON.stringify(pageData, null, 2)
  );

  console.log(`Generated page-${page}.json with ${pageSkills.length} skills`);
}

console.log(`✓ Generated ${totalPages} page files`);
