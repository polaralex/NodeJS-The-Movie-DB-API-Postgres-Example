// @ts-check
const request = require("request");
const util = require("util");
const { Pool, Query } = require("pg");

const apiKey = "[ ADD YOUR OWN API KEY HERE: https://www.themoviedb.org/documentation/api ]";
const region = "DE";

// Change the login data here to suit your own Postgres database:
const pool = new Pool({
  user: "[ADD DATABASE USERNAME]",
  host: "localhost",
  database: "[ADD DATABASE NAME]",
  password: "[ADD DATABASE PASSWORD]",
  port: 5432,
});

const PrepareTheDatabaseQuery = `
BEGIN;

CREATE TABLE IF NOT EXISTS Movie
(
    title "text",
    description "text",
    original_title "text",
    movie_id integer NOT NULL,
    PRIMARY KEY (movie_id)
);

CREATE TABLE IF NOT EXISTS Director
(
    name "text",
    imdb_link "text",
    director_id integer,
    PRIMARY KEY (director_id)
);

CREATE TABLE IF NOT EXISTS DirectingCredit
(
    movie integer references Movie(movie_id),
    director integer references Director(director_id),
    UNIQUE (movie, director)
);
END;
`;

// Prepare the database schema:
pool
  .query(PrepareTheDatabaseQuery)
  .then((res) => {
    console.log("* Schema is successfully created or exists.");
    return pool.query(`SELECT * FROM movie`);
  })
  .catch((err) => {
    console.error(err);
  });

console.log("Script started: Starting to load all data from the API");
let movies = [];
FindMoviesPlayingInRegion(movies);

function FindMoviesPlayingInRegion(currentMovies) {
  console.log("- Finding currently playing movies in region " + region);

  let total_pages = 0;
  let promiseArray = [];

  // Find the total number of pages from this API endpoint:
  CreatePromiseGetCall(BuildGetCurrentlyPlayingInGreece, 1, (body) => {
    total_pages = body.total_pages;
  }).then(() => {
    // Get all movie data from each page of the paginated API:
    for (let i = 1; i <= total_pages; i++) {
      promiseArray.push(
        CreatePromiseGetCall(BuildGetCurrentlyPlayingInGreece, i, (body) => {
          // What to do with the GET response body:
          body.results.forEach((element) => {
            currentMovies.push({
              title: escapeCharacters(element.title),
              id: escapeCharacters(element.id),
            });
          });
        })
      );
    }

    Promise.all(promiseArray).then(function () {
      GetDataForMovies(currentMovies);
    });
  });
}

function GetDataForMovies(currentMovies) {

  console.log("- Getting additional data for " + currentMovies.length + " movies");

  let promiseArray = [];

  currentMovies.forEach((element) => {
    promiseArray.push(
      CreatePromiseGetCall(BuildGetMovieDetailsRequest, element.id, (body) => {
        element.description = escapeCharacters(body.overview);
        element.original_title = escapeCharacters(body.original_title);
        element.imdb_id = escapeCharacters(body.imdb_id);
      })
    );
  });

  Promise.all(promiseArray).then(function () {
    GetDataForCreditsOfMovies(currentMovies);
  });
}

function GetDataForCreditsOfMovies(currentMovies) {

  console.log("- Getting cast data");

  let promiseArray = [];

  currentMovies.forEach((element) => {
    promiseArray.push(
      CreatePromiseGetCall(BuildGetMovieCreditsRequest, element.id, (body) => {
        let directors = [];

        body.crew.forEach((castElement) => {
          if (castElement.job == "Director") {
            directors.push(castElement);
          }
        });

        element.directors = directors;
      })
    );
  });

  Promise.all(promiseArray).then(function () {
    GetPersonData(currentMovies);
  });
}

function GetPersonData(currentMovies) {

  console.log("- Getting additional data for film directors");

  let promiseArray = [];

  currentMovies.forEach((element) => {
    element.directors.forEach((director) => {
      promiseArray.push(
        CreatePromiseGetCall(
          BuildGetPersonDetailsRequest,
          director.id,
          (body) => {
            director.imdb_url = GetImdbLink(body.imdb_id);
          }
        )
      );
    });
  });

  /*
Structure of MovieElement Object:
Movie
  .title
  .id
  .description
  .original_title
  .imdb_id
  .directors[]
    .id
    .imdb_url
    {...}
*/

  Promise.all(promiseArray)
    .then(function () {
      // Un-comment to debug-show the build movie objects' data:
      // currentMovies.forEach((element) => {
      //   console.log(JSON.stringify(element, null, 4));
      // });
    })
    .then(() => {
      let queryPromiseArray = [];

      currentMovies.forEach((element) => {
        let stringQuery = `INSERT INTO movie(title, description, original_title, movie_id)
        VALUES ('${element.title}','${element.description}','${element.original_title}','${element.id}')
        ON CONFLICT (movie_id) 
        DO UPDATE SET description = '${element.description}', title = '${element.title}';
        `;
        console.log(`* Adding ${element.title} movie to database.`);
        queryPromiseArray.push(pool.query(stringQuery));
      });

      return Promise.all(queryPromiseArray);
    })
    .then(() => {
      
      console.log("- Movies were added (or updated) in database");

      let queryPromiseArray = [];

      currentMovies.forEach((element) => {

        // Add directors to the database:
        element.directors.forEach(director => {

          let stringQuery =
          `INSERT INTO director(name, imdb_link, director_id)
          VALUES ('${escapeCharacters(director.name)}','${director.imdb_url}','${director.id}')
          ON CONFLICT (director_id) 
          DO UPDATE SET imdb_link = '${director.imdb_url}';
          `;

          console.log(`* Adding ${director.name} director to database`);
          queryPromiseArray.push(pool.query(stringQuery));

        });
      });

      return Promise.all(queryPromiseArray);

    })
    .then(()=>{

      console.log("- Directors were added (or updated) in database");

      let queryPromiseArray = [];

      currentMovies.forEach((movie) => {

        // Add directors to the database:
        movie.directors.forEach(director => {

          let stringQuery =
          `INSERT INTO directingcredit(movie, director)
          VALUES ('${movie.id}','${director.id}')
          ON CONFLICT (movie, director) DO NOTHING;
          `;

          console.log(`* Added ${movie.title}/${director.name} movie/director relationships to database.`);
          queryPromiseArray.push(pool.query(stringQuery));

        });
      });

      return Promise.all(queryPromiseArray);

    })
    .catch((err) => {
      console.error(err);
    })
    .finally(() => {
      pool.end();
      console.log("-- The script has finished running --")
    });
}

// Helper functions:

// Creator of abstracted functions that create promises for GET requests
// It's being built based on its parameters
// 1. apiQueryCreator: A method that returns a GET url string and takes a parameter
// 2. queryCreatorParameter: The parameter to be passed to apiQueryCreator
// 3. handleResponseBody: A callback to handle the body data returned from the request
function CreatePromiseGetCall(
  apiQueryCreator,
  queryCreatorParameter,
  handleResponseBody
) {
  return new Promise((resolve, reject) => {
    request(
      apiQueryCreator(queryCreatorParameter),
      { json: true },
      (err, res, body) => {
        if (err) {
          console.log(err);
          reject(err);
        }
        handleResponseBody(body);
        resolve(body);
      }
    );
  });
}

function BuildGetMovieDetailsRequest(movie_id) {
  let builtString = `https://api.themoviedb.org/3/movie/${movie_id}?api_key=${apiKey}&language=en-US`;
  return builtString;
}

function BuildGetMovieCreditsRequest(movie_id) {
  let builtString = `https://api.themoviedb.org/3/movie/${movie_id}/credits?api_key=${apiKey}&language=en-US`;
  return builtString;
}

function BuildGetCurrentlyPlayingInGreece(page) {
  let builtString = `https://api.themoviedb.org/3/movie/now_playing?api_key=${apiKey}&language=en-US&page=${page}&region=${region}`;
  return builtString;
}

function BuildGetPersonDetailsRequest(person_id) {
  let builtString = `https://api.themoviedb.org/3/person/${person_id}?api_key=${apiKey}&language=en-US`;
  return builtString;
}

function GetImdbLink(imdb_id) {
  if (imdb_id != null) {
    return `https://www.imdb.com/name/${imdb_id}/`;
  } else {
    return "";
  }
}

function escapeCharacters(inputString) {

  if (inputString == null) {
    return null;
  }

  let escapedInput = inputString
    .toString()
    .replace(/'/g, "`")
    .replace(/"/g, '``');

  return escapedInput;
}