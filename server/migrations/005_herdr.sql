-- herdr (hc) terminals: find the session that runs in a terminal.
CREATE INDEX sessions_hc_terminal ON sessions(machine_id, hc_terminal);
