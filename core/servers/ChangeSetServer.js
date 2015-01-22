var fs    = require('fs'),
    url   = require('url'),
    path  = require('path'),
    async = require('async');
var exec  = require('child_process').execFile,
    spawn = require('child_process').spawn;
var gitHelper = require('lively-git-helper');

var FS_BRANCH = 'master',
    BRANCH_PREFIX = 'lvChangeSet-',
    SUB_REPOS = []; // FIXME: do not hard-code

// determine sub-repos (inside node_mdoules)
fs.readdir(path.join(process.env.WORKSPACE_LK, 'node_modules'), function(err, files) {
    if (err) return;
    files = files.map(function(filename) {
        return path.join(process.env.WORKSPACE_LK, 'node_modules', filename);
    });
    async.map(files, fs.stat, function(err, stats) {
        if (err) return;
        var dirs = files.filter(function(file, idx) {
            return stats[idx].isDirectory();
        });
        dirs = dirs.map(function(dirname) {
            return path.join(dirname, '.git');
        });
        async.filter(dirs, fs.exists, function(dirs){
            SUB_REPOS = dirs.map(function(dir) {
                return dir.substr(0, dir.length - 5);
            });
        });
    });
});

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function getBranches(cb) {
    // only list branches of the main repo
    gitHelper.listBranches(process.env.WORKSPACE_LK, function(err, branches) {
        if (err) return cb(err);
        branches = branches.filter(function(branch) {
            return branch.substr(0, BRANCH_PREFIX.length) == BRANCH_PREFIX;
        }).map(function(branch) {
            return branch.substr(BRANCH_PREFIX.length);
        });
        cb(null, branches);
    });
}

function topologicalSort(arrs, diffProp1, diffProp2) {
    var itemsLeft = arrs.map(function(arr) { return arr.length; }).reduce(function(sum, len) { return sum + len; }, 0),
        ordered = [],
        atArr = 0,
        headItem,
        hasDependency;
    while (itemsLeft > 0) {
        headItem = arrs[atArr][0];
        if (headItem != undefined) {
            hasDependency = arrs.some(function(arr, aIdx) {
                if (aIdx == atArr) return false;
                return arr.some(function(elem, eIdx) {
                    if (eIdx == 0) return false;
                    return (elem[diffProp1] != null ? elem[diffProp1] == headItem[diffProp1] : false) &&
                        (elem[diffProp2] != null ? elem[diffProp2] == headItem[diffProp2] : false);
                })
            });
            if (!hasDependency) {
                arrs.forEach(function(arr, idx) {
                    var elem = arr[0];
                    if (elem && ((elem == headItem) ||
                        (elem[diffProp1] != null ? elem[diffProp1] == headItem[diffProp1] : false) ||
                        (elem[diffProp2] != null ? elem[diffProp2] == headItem[diffProp2] : false))) {
                        arr.shift();
                        itemsLeft--;
                    }
                });
                ordered.push(headItem);
                atArr = -1; // reset idx to prefer first array
            }
        }
        atArr = (atArr + 1) % arrs.length;
    }
    return ordered;
}

function getCommitsByBranch(branch, cb) {
    var repos = [process.env.WORKSPACE_LK].concat(SUB_REPOS);
    branch = BRANCH_PREFIX + branch;

    async.map(repos, function(repo, callback) {
        gitHelper.util.diffCommits(branch, FS_BRANCH, repo, function(err, info) {
            if (err) {
                if (err.code == 'NOTACOMMIT')
                    return callback(null, { added: [], missing: [] }); // empty result
                return callback(err);
            }
             // FIXME: not neccessary anymore when every FS access is commited too
            exec('git', ['ls-files', '-mdso', '--exclude-standard'], { cwd: repo }, function(err, changes) {
                if (err) return callback(err);
                if ((branch != FS_BRANCH) && (changes[0].trim() != '')) {
                    // artificial commit for uncommited changes
                    info.missing.unshift({
                        commitId: null, message: '[Filesystem changes]', notes: null
                    });
                }
                callback(null, info);
            });
        });
    }, function(err, commitInfoByRepo) {
        var sortedCommits = topologicalSort(commitInfoByRepo.map(function(repo) { return repo.added.reverse(); }), 'note', 'message');
        sortedCommits.reverse();
        sortedCommits.forEach(function(commit) {
            if (commit.note) {
                var repos = commit.note.split('\n');
                commit.repos = repos.reduce(function(allRepos, repo) {
                    var parsed = repo.match(/^(.*): ([0-9a-f]+)$/);
                    allRepos[parsed[1]] = parsed[2];
                    return allRepos;
                }, {});
                commit.commitId = commit.repos['.'] || null;
            }
            delete commit.note;
        });
        var result = {
            added: sortedCommits,
            missing: commitInfoByRepo[0].missing
        };
        cb(err, result);
    });
}

function getCommits(branch, cb) {
    function commitsForBranches(branches) {
        var branchCmds = branches.reduce(function(list, branch) {
            list[branch] = getCommitsByBranch.bind(null, branch);
            return list;
        }, {});
        async.parallel(branchCmds, function(err, branchInfo) {
            cb(null, branchInfo);
        });
    }

    if (branch)
        commitsForBranches([branch]);
    else {
        getBranches(function(err, branches) {
            if (err) cb(err);
            else commitsForBranches(branches);
        });
    }
}

function getChanges(b, cb) {
    var repos = [process.env.WORKSPACE_LK].concat(SUB_REPOS),
        branch = b;
    if (branch) branch = BRANCH_PREFIX + branch;

    async.map(repos, function(repoPath, callback) {
        gitHelper.util.getStashHash(branch, repoPath, function(err, changeHash) {
            if (err && !(err instanceof Error))
                err = new Error(err);
            callback(null, err || changeHash)
        });
    }, function(err, results) {
        if (err) return cb('Unexpected error when assembling change set "' + b + '"!');

        var repoInfos = results.reduce(function(res, result, idx) { // filter and zip
            if (!(result instanceof Error))
            res.push({ path: repos[idx], changeHash: result });
            return res;
        }, []);

        if (repoInfos.length == 0) return cb('Could not find change set "' + b + '"!');
        async.map(repoInfos, function(repoInfo, callback) {
            gitHelper.util.readCommit(repoInfo.changeHash, repoInfo.path, process.env.WORKSPACE_LK, callback);
        }, function(err, changesArr) {
            if (err) return cb(err);

            var changeSet = changesArr.reduce(function(all, changes, idx) {
                var subst = '$& ' + repoInfos[idx].changeHash;
                changes.forEach(function(change) {
                    all.push(change.replace(/^@@.*@@$/m, subst));
                });
                return all;
            }, []);
            cb(null, changeSet);
        });
    });
}

function getBranchAndParentFromChangeId(changeId, repo, cb) {
    gitHelper.util.getBranchesByHash(changeId, repo, function(err, branches) {
        if (err) return cb(err);
        gitHelper.util.getParentHash(changeId + '^1', repo, function(err, parent) {
            if (err) return cb(err);
            // should not be more than one branch!!
            cb(null, branches && branches[0], parent);
        });
    });
}

function getOldFilename(diff) {
    var filename = diff.match(/^\-\-\- (.*)$/m)[1].trim();
    return filename != '/dev/null' ? filename.substr(2) : null;
}

function getNewFilename(diff) {
    var filename = diff.match(/^\+\+\+ (.*)$/m)[1].trim();
    return filename != '/dev/null' ? filename.substr(2) : null;
}

function normalizeDiffFilenames(diffs, repoPath) {
    var relPath = path.relative(process.env.WORKSPACE_LK, repoPath);
    return diffs.map(function(diff) {
        var oldFilename = getOldFilename(diff),
            newFilename = getNewFilename(diff);
        if (oldFilename)
            diff = diff.replace('--- a/' + oldFilename, '--- a/' + path.relative(relPath, oldFilename));
        if (newFilename)
            diff = diff.replace('+++ b/' + newFilename, '+++ b/' + path.relative(relPath, newFilename));
        return diff;
    });
}

function commitChanges(diffsToCommit, diffsToStash, message, commiter, cb) {
    var files = [],
        reposByChangeId = {}; // { CHANGE_ID*: { path: PATH, changes: DIFF*, commitId: HASH } }

    function fillRepos(reposMap, diffs, storage) {
        diffs.each(function(diff) {
            var match = diff.match(/^@@.*@@ (.+)$/m),
                changeId = match && match[1].trim();
            if (!reposMap.hasOwnProperty(changeId)) {
                reposMap[changeId] = { changes: [], stash: [] };
                var filename = getNewFilename(diff) || getOldFilename(diff);
                filename = path.join(process.env.WORKSPACE_LK, filename);
                reposMap[changeId].path = SUB_REPOS.filter(function(repoPath) {
                    return filename.indexOf(repoPath) == 0;
                })[0] || process.env.WORKSPACE_LK;
            }
            reposMap[changeId][storage].push(diff);
        });
    }

    fillRepos(reposByChangeId, diffsToCommit, 'changes');
    fillRepos(reposByChangeId, diffsToStash, 'stash');

    async.eachSeries(Object.getOwnPropertyNames(reposByChangeId),
    function(changeId, callback) {
        var repo = reposByChangeId[changeId];
        getBranchAndParentFromChangeId(changeId, repo.path, function(err, branch, parentHash) {
            if (err || branch == undefined) return callback(err || new Error('No branch found!'));

            var commitObj = {
                treeInfos: {},
                parent: parentHash,
            };

            repo.changes = normalizeDiffFilenames(repo.changes, repo.path);
            repo.stash = normalizeDiffFilenames(repo.stash, repo.path);

            async.waterfall([
                gitHelper.util.createCommitFromDiffs.bind(null, repo.path, repo.changes, commiter, message, commitObj),
                function(commitObj, callback) {
                    // clean commitObj
                    repo.commitId = commitObj.commit;
                    commitObj.parent = commitObj.commit;
                    delete commitObj.commit;
                    delete commitObj.rootTree;
                    callback(null, commitObj);
                },
                gitHelper.util.createCommitFromDiffs.bind(null, repo.path, repo.stash, commiter, null),
                gitHelper.util.updateBranch.bind(null, branch, repo.path)
            ], callback);
        });
    }, function(err) {
        if (err) return cb(err);

        var commitNote = Object.getOwnPropertyNames(reposByChangeId).map(function(changeId) {
            var repo = reposByChangeId[changeId],
                repoName = path.relative(process.env.WORKSPACE_LK, repo.path);
            if (repoName == '') repoName = '.';
            return repoName + ': ' + repo.commitId;
        }).join('\n');

        async.eachSeries(Object.getOwnPropertyNames(reposByChangeId),
        function(changeId, callback) {
            var repo = reposByChangeId[changeId];
            gitHelper.util.addCommitNote(repo.path, repo.commitId, commitNote, callback);
        }, cb);
    });
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

module.exports = function(route, app) {

    app.get(route + 'changesets', function(req, res) {
        getBranches(function(err, branches) {
            if (err) res.status(400).json({ error: String(err) });
            else res.json(branches);
        });
    });

    app.get(route + 'commits/:branch?', function(req, res) {
        var branch = req.param('branch') || req.cookies['livelykernel-branch'];
        if (branch == '*' || branch == undefined)
            branch = '';
        getCommits(branch, function(err, commits) {
            if (err) res.status(400).json({ error: String(err) });
            else res.json(commits);
        });
    });

    app.get(route + 'changes/:branch?', function(req, res) {
        var branch = req.param('branch') || req.cookies['livelykernel-branch'];
        getChanges(branch, function(err, changes) {
            if (err) res.status(400).json({ error: String(err) });
            else res.json(changes);
        });
    });

    app.get(route + 'commit/:commitId', function(req, res) {
        var commitId = req.param('commitId');
        gitHelper.util.readCommit(commitId, process.env.WORKSPACE_LK, function(err, changes) {
            if (err) res.status(400).json({ error: String(err) });
            else res.json(changes);
        });
    });

    app.post(route + 'commit', function(req, res) {
        var commit = req.body && req.body.commit,
            stash = req.body && req.body.stash,
            user = req.body && req.body.user,
            email = req.body && req.body.email,
            message = req.body && req.body.message,
            force = req.body && !!(req.body.force);
        if (!commit)
            res.status(400).json({ error: 'Could not find changes to commit (commit)!' });
        else if (!stash)
            res.status(400).json({ error: 'Could not find remaining, uncommited changes (stash)!' });
        else if (!message)
            res.status(400).json({ error: 'Could not find commit message!' });
        else if (!user)
            res.status(400).json({ error: 'Could not find user name!' });
        else if (!email)
            res.status(400).json({ error: 'Could not find user email!' });
        else {
            var commiter = {
                GIT_AUTHOR_NAME: user,
                GIT_AUTHOR_EMAIL: email,
                GIT_COMMITTER_NAME: 'Lively ChangeSets',
                GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
            };
            commitChanges(commit, stash, message, commiter, function(err) {
                if (err)
                    res.status(409).json({ error: 'Files have changed!' });
                else
                    res.status(201).json('Commit successful!');
            });
        }
    });

    app.get(route + 'merge/:branch1/:branch2?', function(req, res) {
        var toBranch = req.param('branch2') || req.param('branch1'),
            fromBranch = req.param('branch2') ? req.param('branch1') : req.cookies['livelykernel-branch'];
        if ((fromBranch == undefined) || (toBranch == undefined))
            res.status(400).json({ error: 'Could not find changeset to merge from or to.' });
        else if (fromBranch == toBranch)
            res.status(400).json({ error: 'Changeset to merge from and to cannot be the same (' + fromBranch + ').' });
        else {
            res.json({ merge: { from: fromBranch, to: toBranch }});
        }
    });

}

module.exports.getBranches = getBranches;
module.exports.getCommits = getCommits;