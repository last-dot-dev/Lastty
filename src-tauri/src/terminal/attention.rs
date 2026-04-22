pub(crate) fn detect_approval_menu(tail: &str) -> bool {
    tail.contains("Esc to cancel")
        || tail.contains("[Enter to continue]")
        || tail.contains("Do you want to proceed?")
}

#[cfg(test)]
mod tests {
    use super::detect_approval_menu;

    #[test]
    fn detects_esc_to_cancel_footer() {
        assert!(detect_approval_menu(
            "Do you want to proceed?\n  1. Yes\n  2. No\n\nEsc to cancel  \u{00b7}  Tab to amend"
        ));
    }

    #[test]
    fn detects_enter_to_continue_pagination() {
        assert!(detect_approval_menu(
            "...output truncated...\n[Enter to continue]"
        ));
    }

    #[test]
    fn detects_proceed_question_alone() {
        assert!(detect_approval_menu("Do you want to proceed?"));
    }

    #[test]
    fn ignores_empty() {
        assert!(!detect_approval_menu(""));
    }

    #[test]
    fn ignores_plain_shell_prompts() {
        assert!(!detect_approval_menu("user@host:~/code $ "));
        assert!(!detect_approval_menu("\u{276f} "));
        assert!(!detect_approval_menu("~/code \u{276f} git status"));
    }

    #[test]
    fn ignores_common_tui_output() {
        assert!(!detect_approval_menu(
            "diff --git a/foo b/foo\n-  old line\n+  new line"
        ));
        assert!(!detect_approval_menu(
            "Usage: rg [OPTIONS] PATTERN [PATH ...]\n\nArguments:\n  PATTERN  the regex"
        ));
        assert!(!detect_approval_menu("q quit  h help  j down  k up"));
    }

    #[test]
    fn ignores_partial_mentions_of_proceed() {
        assert!(!detect_approval_menu("Do you want to continue?"));
        assert!(!detect_approval_menu("proceed with the merge (y/n):"));
    }
}
