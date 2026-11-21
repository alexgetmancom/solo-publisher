//! Creates one long-form publication and queues it, in a single transaction.
//! Delivery is the one that already exists: jobs land in `publish_jobs` under
//! an `article:{id}` key and fold back into the article's own status.

use content::Locale;
use content::markdown::parse_markdown_article;
use content::message::slugify;
use db::rusqlite::params;
use foundation::config::Config;
use serde_json::{Map, Value, json};

use super::Publishing;
use super::delivery_payload::new_delivery_payload;
use super::queue::{EnqueuePublishJob, enqueue_publish_job_tx};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::channels::effective_post_targets;
use crate::repositories::immediate_transaction;
use crate::studio_access::primary_studio_actor_id;
use crate::targets::{PublicationForm, TargetMap, target_locale, targets_for};
use crate::{Error, Result};

pub struct PublishArticleInput<'a> {
    pub locale: Locale,
    pub targets: &'a [&'a str],
    pub markdown: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedArticle {
    pub article_id: i64,
    pub publication_ref: String,
    pub title: String,
    pub targets: Vec<String>,
}

impl Publishing<'_> {
    pub fn publish_article(&self, config: &Config, input: &PublishArticleInput<'_>) -> Result<PublishedArticle> {
        let mut targets: Vec<&str> = Vec::new();
        for target in input.targets.iter().copied() {
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        if targets.is_empty() {
            return Err(Error::message("publish needs at least one target"));
        }
        for target in &targets {
            if !targets_for(PublicationForm::Article).any(|carrier| carrier.id == *target) {
                return Err(Error::message(format!(
                    "{target} does not carry articles; it publishes posts"
                )));
            }
            let locale = target_locale(target).expect("every article carrier has a locale");
            if locale != input.locale {
                return Err(Error::message(format!(
                    "{target} is {}, not {}",
                    locale.as_str(),
                    input.locale.as_str()
                )));
            }
        }
        let requested: TargetMap = targets.iter().map(|target| ((*target).to_owned(), true)).collect();
        let deliverable = effective_post_targets(self.sqlite, &requested)?;
        let unconnected: Vec<&str> = targets
            .iter()
            .copied()
            .filter(|target| !deliverable.get(target))
            .collect();
        if !unconnected.is_empty() {
            return Err(Error::message(format!(
                "no connected channel for {}; run `channels` to see what is connected",
                unconnected.join(", ")
            )));
        }
        let article = parse_markdown_article(input.markdown);
        // The title is a field, not the first line of the body. X refuses an
        // untitled Article outright.
        if article.title.is_empty() {
            return Err(Error::message("an article needs a `# Title` heading"));
        }
        let actor_id = primary_studio_actor_id(config)
            .filter(|id| *id != 0)
            .ok_or_else(|| Error::message("publish needs a configured Studio actor"))?;
        let now = self.now();
        let sqlite = self.sqlite;
        let entities = Value::Array(article.body.entities.iter().cloned().map(Value::Object).collect());
        immediate_transaction(sqlite, || {
            let article_id: i64 = sqlite.query_row(
                r#"insert into "articles" ("id", "actor_id", "status", "created_at", "updated_at") values (null, ?, ?, ?, ?) returning "id""#,
                params![actor_id, "draft", now, now],
                |row| row.get(0),
            )?;
            let key = publication_ref(PublicationRefKind::Article, article_id);
            sqlite.execute(
                r#"insert into "article_locales" ("article_id", "locale", "slug", "title", "body_text", "entities_json", "media_json", "published_at", "updated_at") values (?, ?, ?, ?, ?, ?, null, null, ?)"#,
                params![
                    article_id,
                    input.locale.as_str(),
                    slugify(&article.title, article_id),
                    article.title,
                    article.body.text,
                    crate::json::stringify(&entities),
                    now
                ],
            )?;
            for target in &targets {
                // A brand-new article: nothing of it has been published anywhere.
                let mut fields = Map::new();
                fields.insert("locale".into(), json!(input.locale.as_str()));
                fields.insert("title".into(), json!(article.title));
                fields.insert("text".into(), json!(article.body.text));
                fields.insert("entities".into(), entities.clone());
                fields.insert("media".into(), json!([]));
                enqueue_publish_job_tx(
                    self,
                    &EnqueuePublishJob {
                        publication_key: &key,
                        target,
                        payload: &new_delivery_payload(fields),
                        publish_at: Some(&now),
                    },
                )?;
            }
            Ok(PublishedArticle {
                article_id,
                publication_ref: key,
                title: article.title.clone(),
                targets: targets.iter().map(|target| (*target).to_owned()).collect(),
            })
        })
    }
}
