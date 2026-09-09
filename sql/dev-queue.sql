-- Local development queue; executed after Absurd and Spool schema initialization.
select absurd.create_queue('spool_dev', 'unpartitioned');
