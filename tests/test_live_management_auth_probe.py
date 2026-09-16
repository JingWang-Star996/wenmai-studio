import io
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, "tests")

import live_management_auth_probe as probe


class LiveManagementAuthProbeInputTest(unittest.TestCase):
    def test_redirected_stdin_does_not_call_getpass(self) -> None:
        redirected_stdin = io.StringIO("pipe-value\n")
        with (
            patch.object(probe.sys, "stdin", redirected_stdin),
            patch.object(
                probe.getpass,
                "getpass",
                side_effect=AssertionError("getpass must not run for redirected stdin"),
            ),
        ):
            self.assertEqual(probe.read_pairing_code(), "pipe-value")


if __name__ == "__main__":
    unittest.main()
