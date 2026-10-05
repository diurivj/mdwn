DROP INDEX `provisioning_needs_device_idx`;--> statement-breakpoint
CREATE INDEX `provisioning_needs_device_idx` ON `provisioning_needs` (`device_id`,`grant_id`,`grant_key_epoch`);--> statement-breakpoint
DROP INDEX `shares_recipient_idx`;--> statement-breakpoint
CREATE INDEX `shares_recipient_idx` ON `shares` (`recipient_id`,`id`,`owner_id`,`target_id`,`target_kind`,`permission`,`created_at`);--> statement-breakpoint
CREATE INDEX `account_encryption_identities_epoch_idx` ON `account_encryption_identities` (`account_id`,`registry_epoch`);--> statement-breakpoint
CREATE INDEX `comment_thread_epochs_head_idx` ON `comment_thread_epochs` (`thread_id`,`id`,`key_epoch`,`audience`) WHERE "comment_thread_epochs"."state" = 'active';--> statement-breakpoint
CREATE INDEX `device_enrollments_live_idx` ON `device_enrollments` (`id`,`account_id`,`candidate_session_id`,`expires_at`,`state`,`registry_epoch`,`candidate_device_id`);--> statement-breakpoint
CREATE INDEX `device_enrollments_expiry_idx` ON `device_enrollments` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `device_proof_uses_commit_idx` ON `device_proof_uses` (`account_id`,`proof_id`,`commit_token`);--> statement-breakpoint
CREATE INDEX `directories_current_idx` ON `directories` (`node_id`,`owner_id`,`entries_revision`,`key_epoch`);--> statement-breakpoint
CREATE INDEX `files_current_idx` ON `files` (`node_id`,`owner_id`,`current_representation_id`,`current_revision`,`capability_id`,`capability_epoch`);--> statement-breakpoint
CREATE INDEX `import_sessions_live_idx` ON `import_sessions` (`id`,`account_id`,`session_id`,`expires_at`,`state`,`target_directory_id`,`target_owner_id`);--> statement-breakpoint
CREATE INDEX `import_sessions_session_idx` ON `import_sessions` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `publication_requests_file_idx` ON `publication_requests` (`file_id`,`owner_id`,`id`,`requester_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `publications_current_idx` ON `publications` (`file_id`,`state`,`id`,`current_link_id`,`current_representation_id`) WHERE "publications"."state" IN ('active', 'deleting');--> statement-breakpoint
CREATE INDEX `rate_limit_counters_window_idx` ON `rate_limit_counters` (`purpose`,`scope_type`,`scope_id`,`window_ms`,`time_epoch`,`expires_at`,`count`);--> statement-breakpoint
CREATE INDEX `recovery_capsules_generation_idx` ON `recovery_capsules` (`account_id`,`generation`);--> statement-breakpoint
CREATE INDEX `recovery_enrollments_live_idx` ON `recovery_enrollments` (`id`,`account_id`,`session_id`,`expires_at`,`state`,`generation`,`registry_epoch`);--> statement-breakpoint
CREATE INDEX `recovery_enrollments_expiry_idx` ON `recovery_enrollments` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `recovery_enrollments_session_idx` ON `recovery_enrollments` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `registration_challenges_live_idx` ON `registration_challenges` (`id`,`expires_at`,`origin`,`challenge`);--> statement-breakpoint
CREATE INDEX `sessions_authority_idx` ON `sessions` (`id`,`account_id`,`purpose`,`authenticated_passkey_id`,`fresh_asserted_at`,`device_id`,`revoked_at`,`idle_expires_at`,`absolute_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`idle_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_revoked_idx` ON `sessions` (`revoked_at`,`id`) WHERE "sessions"."revoked_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_recovery_idx` ON `sessions` (`created_at`,`id`) WHERE "sessions"."purpose" = 'recovery';--> statement-breakpoint
CREATE INDEX `webauthn_challenges_live_idx` ON `webauthn_challenges` (`id`,`expires_at`,`purpose`,`account_id`,`session_id`,`origin`,`rp_id`,`challenge`);