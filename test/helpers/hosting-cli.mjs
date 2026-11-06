// Disposable hosting service for the service integration tests. No network or personal sign-in.
import { readFileSync, writeFileSync } from 'node:fs';
const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(file, 'utf8'));
state.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(state));
const reply = value => { save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); };
const fail = message => { save(); process.stderr.write(message); process.exit(1); };
if (args[0] === '--version') reply('glab version test');
else if (args.at(-2) !== '--hostname' || args.at(-1) !== 'code.company.test') fail('wrong host');
else if (args[1] === 'user') reply({ id: 1, username: state.account });
else if (args[1] === 'namespaces/org%2Fteam') reply({ id: 2, kind: 'group', full_path: 'org/team' });
else if (args[1] === 'groups/org%2Fteam') reply({ id: 3, full_path: 'org/team', project_creation_level: 'maintainer' });
else if (args[1] === 'groups/3/members/all/1') reply({ id: 1, access_level: 40 });
else if (args[1] === 'projects' && args.includes('POST')) {
 if (state.failCreate) fail('403 forbidden');
 state.created = true;
 reply({ id: 4, path_with_namespace: 'org/team/repo', visibility: 'private' });
} else if (/^projects\/(?:org%2Fteam%2Frepo|4)$/.test(args[1])) {
 if (!state.created) fail('404 Not Found');
 reply({ id: 4, path_with_namespace: 'org/team/repo', permissions: { group_access: { access_level: 40 } } });
} else if (args[1] === 'projects/org%2Fteam%2Frepo/merge_requests' && args.includes('POST')) {
 if (state.failReview) fail('network unavailable');
 const field = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
 state.reviews.push({ state: 'opened', web_url: 'https://code.company.test/org/team/repo/-/merge_requests/1', source_project_id: 4, target_project_id: 4, source_branch: field('source_branch'), target_branch: field('target_branch') });
 reply(state.reviews.at(-1));
} else if (args[1].startsWith('projects/4/merge_requests?')) reply(state.reviews);
else fail('unexpected CLI call: ' + args.join(' '));
