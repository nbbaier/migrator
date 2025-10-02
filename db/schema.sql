CREATE TABLE
   users (
      id INTEGER NOT NULL PRIMARY KEY,
      name text,
      email text,
      age INTEGER,
      address TEXT
   );

CREATE TABLE
   posts (title TEXT, content TEXT, posted TEXT);

CREATE INDEX idx_posts_title ON posts (title);