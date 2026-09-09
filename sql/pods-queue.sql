-- Queue for unattended pods run as Absurd tasks. Applied after the Absurd schema.
select absurd.create_queue('spool_pods', 'unpartitioned');
-- Queue for coordinator tasks that fan out to pods.
select absurd.create_queue('spool_fanout', 'unpartitioned');
