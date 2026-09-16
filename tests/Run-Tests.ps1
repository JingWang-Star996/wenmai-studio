$ErrorActionPreference = 'Stop'
$python = (Get-Command python -ErrorAction Stop).Source
& $python -B tests/test_stage_public_release_candidate.py
