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

    core.info("check basehead commits count.");

    const commits = await octokit.repos
      .compareCommitsWithBasehead({
        owner: args.owner,
        repo: args.repo,
        basehead,
      })
      .then((response) => response.data.commits.map((c) => c.commit.message));

    if (commits.length === 0 && !args.force_updating) {
      core.info("Already up to date.");
      return;
    }

    core.info(`${commits.length} commits found.`);
    core.info("check release pull-request.");

    const release_pull = await octokit.rest.pulls
      .list({
        owner: args.owner,
        repo: args.repo,
        base: args.base,
        head: args.head,
        state: "open",
      })
      .then((response) => (response.data.length > 0 ? response.data[0] : null));

    if (release_pull) {
      core.info(`release pull-request#${release_pull.number} found.`);
      if (!args.force_updating) {
        const matchVersion = release_pull.body.match(
          /### Related Stories <!-- ([0-9a-f]+)\.\.\.([0-9a-f]+)/
        );
        if (
          matchVersion &&
          basehead === `${matchVersion[1]}...${matchVersion[2]}`
        ) {
          core.info("Already up to date.");
          return;
        }
      }
    } else {
      core.info("this repository does not have a release pull-request.");
    }

    const issue_numbers = await commits
      .map((m) => extractIssueNumber(m))
      .filter((n) => n > 0);

    core.info(`${issue_numbers.length} issues detected in the commit log.`);

    const pulls = [];
    const issues = [];
    for (const n of issue_numbers) {
      let iss = await octokit.rest.issues
        .get({ owner: args.owner, repo: args.repo, issue_number: n })
        .then((response) => response.data);
      if (iss.pull_request) {
        core.info(`check related pull-request#${iss.number}`);
        pulls.push(iss);
      } else {
        core.info(`check related issue#${iss.number}`);
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
        .then((response) => {
          response.data.forEach((i) => {
            if (
              i.event === "cross-referenced" &&
              i.source &&
              i.source.issue &&
              !i.source.issue.pull_request
            ) {
              issues.push(i.source.issue);
            }
            const add =
              i.source && i.source.issue
                ? `and issue#${i.source.issue.number} `
                : "";
            core.info(
              `related ${i.event} event ${add}found in #${iss.number}.`
            );
          });
        });
    }

    const related_stories = [];

    related_stories.push(`### Related Stories <!-- ${basehead} -->`, "\n");

    if (pulls.length > 0) {
      related_stories.push("*PullRequests*", "\n");
      pulls
        .sort((x, y) =>
          x.number === y.number ? 0 : x.number < y.number ? -1 : 1
        )
        .filter(
          (pull, i, arr) =>
            i === 0 || (i > 0 && arr[i - 1].number !== pull.number)
        )
        .forEach((pull) => {
          related_stories.push(
            `- ${pull.title} [#${pull.number}](${pull.html_url})`
          );
        });
      related_stories.push("\n");
    }

    if (issues.length > 0) {
      related_stories.push("*Issues*", "\n");
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
          related_stories.push(
            `- ${issue.title} [${issueNum}](${issue.html_url})`
          );
        });
      related_stories.push("\n");
    }

    // console.log(related_stories);
    // return;

    const body = [];

    if (release_pull) {
      core.info("update pull request with the following description.");
      if (release_pull.body.indexOf("### Related Stories") > -1) {
        let isInRelStories = false;
        release_pull.body.split("\n").forEach((ln) => {
          if (isInRelStories) {
            if (ln.startsWith("#")) {
              body.push(ln);
              isInRelStories = false;
            }
          } else if (ln.startsWith("### Related Stories")) {
            isInRelStories = true;
            body.push(...related_stories);
          } else {
            body.push(ln);
          }
        });
      } else {
        if (release_pull.body.length > 0) {
          body.push(release_pull.body);
        }
        body.push(...related_stories);
      }
      await octokit.rest.pulls.update({
        owner: args.owner,
        repo: args.repo,
        pull_number: release_pull.number,
        body: body.join("\n"),
      });
    } else {
      core.info("create pull request with the following description.");
      related_stories.forEach((s) => body.push(s));
      const p = await octokit.rest.pulls
        .create({
          owner: args.owner,
          repo: args.repo,
          base: args.base,
          head: args.head,
          title: "Release",
          body: body.join("\n"),
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
    core.info(">")
    body.forEach((s) => core.info(`> ${s}`));
  } catch (error) {
    core.setFailed(error.message);
  }
}

const [default_owner, default_repo] =
  process.env.GITHUB_REPOSITORY.indexOf("/") > -1
    ? process.env.GITHUB_REPOSITORY.split("/")
    : ["", ""];

main({
  owner: withDefaultValue(github.context.repo.owner, default_owner),
  repo: withDefaultValue(github.context.repo.repo, default_repo),
  base: withDefaultValue(core.getInput("base"), process.env.INPUT_BASE),
  head: withDefaultValue(core.getInput("head"), process.env.INPUT_HEAD),
  label: withDefaultValue(core.getInput("label"), process.env.INPUT_LABEL),
  force_updating:
    withDefaultValue(
      core.getInput("force_updating"),
      process.env.INPUT_FORCE_UPDATING
    ) === "true",
});
