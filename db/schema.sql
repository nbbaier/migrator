CREATE TABLE
    users (
        id INTEGER NOT NULL PRIMARY KEY,
        name text,
        email text
    );

CREATE TABLE
    posts (
        id INTEGER NOT NULL PRIMARY KEY,
        title TEXT,
        content TEXT,
        posted TEXT
    );

CREATE TABLE
    likes (
        likes INTEGER,
        post_id INTEGER,
        FOREIGN KEY (post_id) REFERENCES posts (id)
    );