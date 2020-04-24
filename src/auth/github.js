const express = require('express');
const passport = require('passport');
const GitHubStrategy = require('passport-github').Strategy;
const uuidv4 = require('uuid/v4');
const { graphql_client } = require('../graphql-client');
const auth_functions = require('./auth-functions');

const {
  AUTH_GITHUB_CLIENT_ID,
  AUTH_GITHUB_CLIENT_SECRET,
  AUTH_GITHUB_CALLBACK_URL,
  AUTH_GITHUB_AUTHORIZATION_URL,
  AUTH_GITHUB_TOKEN_URL,
  AUTH_GITHUB_USER_PROFILE_URL,
  STORAGE_ACTIVE,
  JWT_TOKEN_EXPIRES,
  REFRESH_TOKEN_EXPIRES,
  USER_FIELDS,
  PROVIDERS_SUCCESS_REDIRECT,
  PROVIDERS_FAILURE_REDIRECT,
} = require('../config');

let router = express.Router();

passport.use(new GitHubStrategy({
  clientID: AUTH_GITHUB_CLIENT_ID,
  clientSecret: AUTH_GITHUB_CLIENT_SECRET,
  callbackURL: AUTH_GITHUB_CALLBACK_URL,
  authorizationURL: AUTH_GITHUB_AUTHORIZATION_URL,
  tokenURL: AUTH_GITHUB_TOKEN_URL,
  userProfileURL: AUTH_GITHUB_USER_PROFILE_URL,
  scope: ['user:email'],
},
async function(accessToken, refreshToken, profile, cb) {

  // find or create user

  // see if the user already exists
  const query = `
  query (
    $profile_id: String!
  ) {
    user_providers: auth_user_providers (
      where: {
        _and: [{
          auth_provider: {_eq: "github"}
        }, {
          auth_provider_unique_id: { _eq: $profile_id }
        }]
      }
    ) {
      user {
        id
        active
        default_role
        is_anonymous
        user_roles {
          role
        }
        ${USER_FIELDS.join('\n')}
      }
    }
  }
  `;

  let hasura_data;
  let user = null;
  try {
    hasura_data = await graphql_client.request(query, {
      profile_id: profile.id,
    });
  } catch (e) {
    // console.error('Error connection to GraphQL');
    console.error(e);
    return cb(null, false, { message: 'unable to check if user exists' });
  }

  // if user not yet exists
  if (hasura_data.user_providers.length == 0) {

    // create the user
    // create user account
    const mutation  = `
    mutation (
      $user: users_insert_input!
    ) {
      inserted_user: insert_users (
        objects: [$user]
      ) {
        returning {
          id
          active
          default_role
          user_roles {
            role
          }
          is_anonymous
          ${USER_FIELDS.join('\n')}
        }
      }
    }
    `;

    let email;
    try {
      email = profile.emails[0].value;
    } catch (e) {
      email = '';
    }

    let avatar_url;
    try {
      avatar_url = profile.photos[0].value;
    } catch (e) {
      avatar_url = '';
    }

    // create user and user_account in same mutation
    try {
      hasura_data = await graphql_client.request(mutation, {
        user: {
          display_name: profile.displayName,
          email: email,
          active: true,
          avatar_url: avatar_url,
          user_providers: {
            data: {
              auth_provider: profile.provider,
              auth_provider_unique_id: profile.id,
            },
          },
        },
      });
    } catch (e) {
      console.error(e);
      return cb(null, false, { message: 'error hasura data two 2' });
    }

    user = hasura_data.inserted_user.returning[0];
  } else {
    // user exists
    // get user
    user = hasura_data.user_providers[0].user;
  }

  return cb(null, user);
}));

router.get('/',
  passport.authenticate('github', {
    session: false,
  })
);

router.get('/callback',
  passport.authenticate('github', {
    failureRedirect: PROVIDERS_FAILURE_REDIRECT,
    session: false,
   }),
  async function(req, res) {

    // Successful authentication, redirect home.
    // generate tokens and redirect back home

    const { user } = req;

    const jwt_token = auth_functions.generateJwtToken(user);

    // generate refresh token and put in database
    const query = `
    mutation (
      $refresh_token_data: auth_refresh_tokens_insert_input!
    ) {
      insert_auth_refresh_tokens (
        objects: [$refresh_token_data]
      ) {
        affected_rows
      }
    }
    `;

    const refresh_token = uuidv4();
    let hasura_data;
    try {

      // only set 5 min exp time. Callback to app should make the app do a instant
      // refresh of this particular token.

      hasura_data = await graphql_client.request(query, {
        refresh_token_data: {
          user_id: user.id,
          refresh_token: refresh_token,
          expires_at: new Date(new Date().getTime() + (2 * 60 * 1000)),
        },
      });
    } catch (e) {
      console.error(e);
      return res.send("Could not update 'refresh token' for user");
    }

    // send user back
    let callback_url = '';
    if (PROVIDERS_SUCCESS_REDIRECT.indexOf('?') > 1) {
      callback_url = `${PROVIDERS_SUCCESS_REDIRECT}&refresh_token=${refresh_token}`;
    } else {
      callback_url = `${PROVIDERS_SUCCESS_REDIRECT}?refresh_token=${refresh_token}`;
    }

    res.redirect(callback_url);
  }
);

module.exports = router;