# Release keys

This folder is the trust root of the release workflow. Each `.asc` file is the armored OpenPGP
public key of one maintainer, named after their GitHub login (`<login>.asc`). A release starts from
a `vX.Y.Z` tag. The release workflow runs `scripts/verify-release-tag.ts` first and accepts the tag
only when a key from this folder signed it. A lightweight tag, an annotated tag without a
signature, or a tag signed by another key stops the workflow before anything is built.

The trust root covers tags only. Commits merged on GitHub are signed by GitHub's own key, which is
not in this folder and must never be added.

Only public keys live here. The script refuses a file that contains `PRIVATE KEY`, a file that is
not one armored public-key block, and a file that holds more than one key.

| File           | Fingerprint                                         |
| -------------- | --------------------------------------------------- |
| `aelmanaa.asc` | `A768 643D E0F2 8FFE 4EBC 21EE FF17 3FDE 6FF6 0A5C` |

The same key is the release key of aelmanaa/hardhat-kms and aelmanaa/explorer-verify.

## Add a maintainer

1. The maintainer exports the public key they sign tags with:

   ```sh
   gpg --armor --export <key-id> > .github/release-keys/<github-login>.asc
   ```

   Export the whole key, not a subkey alone. The script matches the primary key's fingerprint, so a
   tag signed by a signing subkey of that key passes.

2. They open a pull request that adds the file and nothing else, and give the key's fingerprint
   (`gpg --fingerprint <key-id>`) in the pull request body. The reviewer checks that GitHub serves
   the same key for that account:
   `curl -fsSL https://github.com/<github-login>.gpg | gpg --show-keys` prints the fingerprint of
   each key on the account, and one of them must match.
3. A maintainer reviews the fingerprint and merges. From the next tag on, that key can start a
   release.

The tag ruleset (`.github/ruleset-protect-tags.json`) lets only a repository admin create, move or
delete a `v*` tag. A new maintainer who is not an admin also needs that role, or a place in the
ruleset's bypass list, before they can push a release tag.

To remove a maintainer, open a pull request that deletes their file.

## Check a tag before pushing it

```sh
git fetch origin main
node scripts/verify-release-tag.ts v0.1.0
```

The script imports the keys into a temporary `GNUPGHOME`, so it never touches your own keyring. It
prints one line: the signer, version and commit when the tag passes, or the reason it fails.
