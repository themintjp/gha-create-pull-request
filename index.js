const core = require("@actions/core");
const github = require("@actions/github");
const { Octokit } = require("@octokit/rest");

function withDefaultValue(v, defaultValue) {
  if (v) return v;
  return defaultValue;
}

function extractIssueNumber(s) {
  const match = s.match(/#(\d+)/);
  if (!match) {
    return NaN;
  }
  return Number(match[1]);
}

async function main(args) {
  try {
    const repoFullname = `${args.owner}/${args.repo}`;
    const auth = process.env.GITHUB_TOKEN;
    if (!auth) {
      throw new Error("no github secret");
    }
    const octokit = new Octokit({ auth });

    const base = await octokit.repos
      .getBranch({ owner: args.owner, repo: args.repo, branch: args.base })
      .then((response) => response.data.commit.sha);

    const head = await octokit.repos
      .getBranch({ owner: args.owner, repo: args.repo, branch: args.head })
      .then((response) => response.data.commit.sha);

    const basehead = `${base.slice(0, 7)}...${head.slice(0, 7)}`;

    const commits = await octokit.repos
      .compareCommitsWithBasehead({
        owner: args.owner,
        repo: args.repo,
        basehead,
      })
      .then((response) => response.data.commits.map((c) => c.commit.message));

    if (commits.length === 0 && !args.force_updating) {
      return;
    }

    const releasePull = await octokit.rest.pulls
      .list({
        owner: args.owner,
        repo: args.repo,
        base: args.base,
        head: args.head,
        state: "open",
      })
      .then((response) => (response.data.length > 0 ? response.data[0] : null));

    if (releasePull && !args.force_updating) {
      const matchVersion = releasePull.body.match(
        /### Related Stories <!-- ([0-9a-f]+)\.\.\.([0-9a-f]+)/
      );
      if (
        matchVersion &&
        basehead === `${matchVersion[1]}...${matchVersion[2]}`
      ) {
        core.info("no update");
        return;
      }
    }

    const issueNumbers = await commits
      .map((m) => extractIssueNumber(m))
      .filter((n) => n > 0);
    const pulls = [];
    const issues = [];
    for (const n of issueNumbers) {
      let iss = await octokit.rest.issues
        .get({ owner: args.owner, repo: args.repo, issue_number: n })
        .then((response) => response.data);
      if (iss.pull_request) {
        pulls.push(iss);
      } else {
        issues.push(iss);
      }
      // このissueを外部から参照したissueを関連issueに含める
      // このissueのbodyやコメントのテキスト内で参照ているissue/pullは関連issueに含めない
      await octokit.rest.issues
        .listEventsForTimeline({
          owner: args.owner,
          repo: args.repo,
          issue_number: n,
        })
        .then((response) =>
          response.data
            .filter(
              (i) =>
                i.event === "cross-referenced" &&
                i.source &&
                i.source.issue &&
                !i.source.issue.pull_request
            )
            .forEach((i) => {
              issues.push(i.source.issue);
            })
        );
    }

    const relatedStories = [];

    if (pulls.length > 0 || issues.length > 0) {
      relatedStories.push(`### Related Stories <!-- ${basehead} -->\n`);
    }

    if (pulls.length > 0) {
      relatedStories.push("*PullRequests*\n");
      pulls
        .sort((x, y) =>
          x.number === y.number ? 0 : x.number < y.number ? -1 : 1
        )
        .filter(
          (pull, i, arr) =>
            i === 0 || (i > 0 && arr[i - 1].number !== pull.number)
        )
        .forEach((pull) => {
          relatedStories.push(
            `- ${pull.title} [#${pull.number}](${pull.html_url})`
          );
        });
      relatedStories.push("\n");
    }

    if (issues.length > 0) {
      relatedStories.push("*Issues*\n");
      issues
        .map((i) => ({
          ...i,
          repository_fullname: i.html_url.replace(
            /^https:\/\/github\.com\/(.*)\/issues\/\d+$/,
            "$1"
          ),
        }))
        .sort((x, y) => {
          if (x.repository_fullname === y.repository_fullname) {
            return x.number === y.number ? 0 : x.number < y.number ? -1 : 1;
          }
          if (x.repository_fullname === repoFullname) {
            return -1;
          } else if (y.repository_fullname === repoFullname) {
            return 1;
          }
          return x.repository_fullname < y.repository_fullname ? -1 : 1;
        })
        .filter(
          (issue, i, arr) =>
            i === 0 ||
            (i > 0 &&
              arr[i - 1].repository_fullname !== issue.repository_fullname)
        )
        .forEach((issue) => {
          const issueNum =
            issue.repository_fullname === repoFullname
              ? `#${issue.number}`
              : issue.repository_fullname.startsWith(args.owner)
              ? `${issue.repository_fullname.replace(/.*\//, "")}#${
                  issue.number
                }`
              : `${issue.repository_fullname}#${issue.number}`;
          relatedStories.push(
            `- ${issue.title} [${issueNum}](${issue.html_url})`
          );
        });
      relatedStories.push("\n");
    }

    // console.log(relatedStories);
    // return;

    if (releasePull) {
      const body = [];
      if (releasePull.body.indexOf("### Related Stories") > -1) {
        let isInRelStories = false;
        releasePull.body.split("\n").forEach((ln) => {
          if (isInRelStories) {
            if (ln.startsWith("#")) {
              body.push(ln);
              isInRelStories = false;
            }
          } else if (ln.startsWith("### Related Stories")) {
            isInRelStories = true;
            body.push(...relatedStories);
          } else {
            body.push(ln);
          }
        });
      } else {
        if (releasePull.body.length > 0) {
          body.push(releasePull.body);
        }
        body.push(...relatedStories);
      }
      await octokit.rest.pulls.update({
        owner: args.owner,
        repo: args.repo,
        pull_number: releasePull.number,
        body: body.join("\n"),
      });
    } else {
      const p = await octokit.rest.pulls
        .create({
          owner: args.owner,
          repo: args.repo,
          base: args.base,
          head: args.head,
          title: "Release",
          body: relatedStories.join("\n"),
        })
        .then((response) => response.data);
      if (args.label) {
        await octokit.rest.issues.addLabels({
          owner: args.owner,
          repo: args.repo,
          issue_number: p.number,
          labels: ["release"],
        });
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

main({
  owner: github.context.repo.owner,
  repo: github.context.repo.repo,
  base: withDefaultValue(core.getInput("base"), process.env.INPUT_BASE),
  head: withDefaultValue(core.getInput("head"), process.env.INPUT_HEAD),
  label: withDefaultValue(core.getInput("label"), process.env.INPUT_LABEL),
  force_updating:
    withDefaultValue(
      core.getInput("force_updating"),
      process.env.INPUT_FORCE_UPDATING
    ) === "true",
});
