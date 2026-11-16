## [2.6.0] - 2026-11-16

### 🚀 Features

- *(review)* Make the model thinking level configurable
- *(review)* Re-review only what changed since the last review
- *(review)* Focus the agent on changes since the last review
- *(review)* Gate a merge check on review confidence

### 🐛 Bug Fixes

- *(review)* Re-evaluate disputed findings instead of skipping
- *(review)* Review in full when the merge base moves off
- *(review)* Reject dispositions for threads the prompt did not supply
## [2.5.0] - 2026-11-15

### 🚀 Features

- *(review)* Report model provider failures as ProviderError

### 💼 Other

- *(deps)* Add effect 4.1.4

### 🚜 Refactor

- *(review)* Run the review core on Effect services and typed errors

### 🧪 Testing

- *(review)* Cover typed failures, failure output and agent session release

### ⚙️ Miscellaneous Tasks

- *(format)* Skip the generated changelog in oxfmt
## [2.4.0] - 2026-11-15

### 🚀 Features

- Support custom model API base URL
## [2.3.0] - 2026-10-25

### 🚀 Features

- Take replies under findings into account

### 🐛 Bug Fixes

- Include outdated flag for resolved discussions
## [2.2.0] - 2026-10-24

### 🚀 Features

- Stop writing review status into the pull request description
- Skip reviews for pull requests by head branch
- Always log the current review step
## [2.1.0] - 2026-10-23

### 🚀 Features

- Support posting reviews as a GitHub App
- List findings with severity badges and links in the general comment

### 🐛 Bug Fixes

- Fold findings outside the diff into the general comment
- Never overflow the general comment with 422-folded findings
- Keep the review when a fixed thread cannot be resolved
- Size-check the worst-case general comment before publishing
- Grant contents: write so Janitor can resolve fixed threads

### 📚 Documentation

- Note the contents: write exposure of floating Janitor tags

### ⚙️ Miscellaneous Tasks

- Revert unrelated CHANGELOG formatting
## [2.0.1] - 2026-10-21

### ⚙️ Miscellaneous Tasks

- Update repository information
## [0.2.0] - 2026-10-21

### 🚀 Features

- Review indicators & logging
- Add review spend tracking

### 🐛 Bug Fixes

- Review status is best effort
- Better handle of reserved janitor markets
- Centralize marker definitions
- Enable logging in workflow
- Create general comment earlier in the run to have on top of the pr
- Hide spend metadata JSON inside comment
- Recognize janitor review threads authored by bots in graphql

### ⚙️ Miscellaneous Tasks

- Use local source instead of released version
- Add dependabot for updates
- Upgrade pi-coding-agent to 1.3
## [0.1.0] - 2026-07-27

### 🚀 Features

- Initial commit
